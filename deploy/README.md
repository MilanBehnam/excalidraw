# Deploy on AWS (live collaboration + shared collections)

One CloudFormation stack ([aws.yml](aws.yml)) creates everything:

- **DynamoDB** (collections, file lists) and **S3** (drawings, images). Everything is end-to-end encrypted, and keys live only in share links.
- An **EC2** instance with a fixed IP. It clones this repo and runs [docker-compose.yml](docker-compose.yml):
  - **app**: the frontend.
  - **backend**: live-sync sockets and the collections API.
  - **Caddy**: automatic HTTPS.
- An IAM role, so the server needs no stored AWS keys.

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
