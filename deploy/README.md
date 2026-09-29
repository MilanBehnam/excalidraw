# Deploy on AWS (live collaboration + shared collections)

One CloudFormation stack ([aws.yml](aws.yml)) creates everything:

- **DynamoDB** (collections, file lists) and **S3** (drawings, images). Everything is end-to-end encrypted, and keys live only in share links.
- An **EC2** instance with a fixed IP. It clones this repo and runs [docker-compose.yml](docker-compose.yml):
  - **app**: the frontend.
  - **backend**: live-sync sockets and the collections API.
  - **Caddy**: automatic HTTPS.
- An IAM role, so the server needs no stored AWS keys.

## Deployer permissions

[deployer-policy.json](deployer-policy.json) is a least-privilege IAM policy for the user that runs the deploy. It's scoped like this:

- **Tags:** EC2 resources can only be created with the tag `Project=excalidraw`, and only resources with that tag can be changed or deleted. Tags can't be added to other existing resources.
- **Names:** IAM, DynamoDB, S3 and the stack itself are limited to names starting with `excalidraw` (CloudFormation names resources after the stack).
- **iam:PassRole:** only this stack's role, and only to EC2.
- **Wildcards:** only for read-only calls that AWS can't scope to a resource (`Describe*`, `tag:GetResources`, `ssm:GetCommandInvocation`).

Fill in your account ID and attach it to the deploy user:

```bash
ACCOUNT_ID=123456789012   # your account
sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" deploy/deployer-policy.json > /tmp/excalidraw-deployer.json
aws iam create-policy --policy-name excalidraw-deployer \
  --policy-document file:///tmp/excalidraw-deployer.json
aws iam attach-user-policy --user-name <your IAM user> \
  --policy-arn arn:aws:iam::$ACCOUNT_ID:policy/excalidraw-deployer
```

The stack must be named `excalidraw` in `us-east-1`; the policy is scoped to that. Every project resource then appears together under the **Resource Groups** console → group `excalidraw`.

## Deploy

```bash
aws cloudformation deploy --template-file deploy/aws.yml \
  --stack-name excalidraw --capabilities CAPABILITY_IAM \
  --parameter-overrides Passcode=<at least 8 characters>
aws cloudformation describe-stacks --stack-name excalidraw \
  --query "Stacks[0].Outputs" --output table
```

Open the `Url` output (`https://<ip>.sslip.io`). The first build takes **~10–15 minutes** on a t3.small. Until then the page doesn't load.

Optional parameters:

- `Domain=draw.example.com`: use your own domain. Point its A record at the stack's IP.
- `InstanceType=t3.medium`: faster builds.
- `RepoUrl=…` and `Branch=…`: deploy another fork or branch.

The passcode is needed to create collections. Friends who get a share link don't need it.

## Update to the latest code

Push to the deployed branch, then:

```bash
aws ssm send-command --instance-ids <InstanceId output> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/excalidraw && git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build"]'
```

## Troubleshooting

To watch the first boot: in the EC2 console, open the instance and choose **Actions → Monitor and troubleshoot → Get system log**. Or open a shell with **Connect → Session Manager** and run `sudo tail -f /var/log/cloud-init-output.log`.

## Delete

```bash
aws cloudformation delete-stack --stack-name excalidraw
```

The DynamoDB table and S3 bucket are kept (`DeletionPolicy: Retain`) so drawings aren't lost by accident. Delete them in the console if you really want them gone.

## Local development

```bash
docker compose -f backend/docker-compose.yml up --build   # backend + DynamoDB Local + S3Mock, passcode "dev"
yarn start                                                  # app on http://localhost:3001
docker compose -f backend/docker-compose.yml exec -e PASSCODE=dev backend node --test test.ts
```
