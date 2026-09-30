# Deploy on AWS (live collaboration + shared collections)

One CloudFormation stack ([aws.yml](aws.yml)) creates everything:

- **DynamoDB** (collections, file lists) and **S3** (drawings, images). Everything is end-to-end encrypted, and keys live only in share links.
- An **EC2** instance with a fixed IP. It clones this repo and runs [docker-compose.yml](docker-compose.yml):
  - **app**: the frontend.
  - **backend**: live-sync sockets and the collections API.
  - **Caddy**: automatic HTTPS.
- An IAM role, so the server needs no stored AWS keys.

## 1. One-time setup (admin)

[bootstrap.yml](bootstrap.yml) creates two things:

- **`excalidraw-cloudformation`**: the role CloudFormation uses to create the resources. It can only touch this project's resources: fixed names (`excalidraw-backend` role, `excalidraw` table, `excalidraw-<account id>` bucket, `excalidraw` resource group) and EC2 resources tagged `Project=excalidraw`. Only Canonical's Ubuntu images are allowed, and `iam:PassRole` passes the backend role to EC2 only.
- **`excalidraw-deployer`**: the policy for your deploy user. It can run only the `excalidraw` stack, only through that role, and has no wildcard resources. The one `*` is the stack id AWS appends to stack ARNs (`stack/excalidraw/<generated id>`).

Run this as an admin. The easiest place is **AWS CloudShell** (the terminal icon in the console), which is already signed in:

```bash
git clone https://github.com/MilanBehnam/excalidraw && cd excalidraw
aws cloudformation deploy --template-file deploy/bootstrap.yml \
  --stack-name excalidraw-bootstrap --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides DeployUser=<your IAM user>
```

## 2. Deploy (deploy user)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws cloudformation deploy --template-file deploy/aws.yml \
  --stack-name excalidraw --capabilities CAPABILITY_NAMED_IAM \
  --role-arn arn:aws:iam::$ACCOUNT_ID:role/excalidraw-cloudformation
aws cloudformation describe-stacks --stack-name excalidraw \
  --query "Stacks[0].Outputs" --output table
```

Open the `Url` output (`https://<ip>.sslip.io`). The first build takes **~10–15 minutes** on a t3.small. Until then the page doesn't load.

Everything the stack creates appears together under **Resource Groups** → group `excalidraw`.

Optional parameters:

- `Domain=draw.example.com`: use your own domain. Point its A record at the stack's IP.
- `InstanceType=t3.medium`: faster builds.
- `RepoUrl=…` and `Branch=…`: deploy another fork or branch.

Accounts are **AWS Cognito** (user pool `excalidraw`): sign-up with email and a verification code, login, password reset. Cognito sends those emails itself, up to 50 a day, no domain needed. Collections and quick live rooms need an account; joining a quick room via its link doesn't.

## Updates

Push to `master`. GitHub Actions ([deploy-images.yml](../.github/workflows/deploy-images.yml)) builds the app and backend images, taking about 5 minutes, and publishes them to GitHub Container Registry (`ghcr.io/<owner>/excalidraw-app` and `-backend`, tagged with the commit). Every 5 minutes the server pulls the images for the latest commit and restarts ([update.sh](update.sh)); it never builds anything itself. The log is at `/var/log/excalidraw-update.log`.

Packages published from a public repository are public, so the server pulls them without logging in.

## The site on GitHub Pages

The same app is also published to **https://<owner>.github.io/<repo>/** ([deploy-pages.yml](../.github/workflows/deploy-pages.yml)) on every push. It talks to this backend cross-origin. The setup:

- Repository variable `BACKEND_URL` = the stack's `CdnUrl` output.
- Settings → Pages → Source: **GitHub Actions**.
- `CORS_ORIGIN=https://<owner>.github.io` in the server's `deploy/.env`.

## Troubleshooting

To watch the first boot: in the EC2 console, open the instance and choose **Actions → Monitor and troubleshoot → Get system log**. Or open a shell with **Connect → Session Manager** and run `sudo tail -f /var/log/cloud-init-output.log`.

## Delete

```bash
aws cloudformation delete-stack --stack-name excalidraw \
  --role-arn arn:aws:iam::$ACCOUNT_ID:role/excalidraw-cloudformation
```

The DynamoDB table and S3 bucket are kept (`DeletionPolicy: Retain`) so drawings aren't lost by accident. Because their names are fixed, delete them in the console before creating the stack again.

## Local development

```bash
docker compose -f backend/docker-compose.yml up --build   # backend + DynamoDB Local + S3Mock, made-up dev logins
yarn start                                                  # app on http://localhost:3001
docker compose -f backend/docker-compose.yml exec backend node --test test.ts
```
