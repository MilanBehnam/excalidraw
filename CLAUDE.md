# CLAUDE.md

## Project Structure

Excalidraw is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Workflow

1. **Package Development**: Work in `packages/*` for editor features
2. **App Development**: Work in `excalidraw-app/` for app-specific features
3. **Testing**: Always run `yarn test:update` before committing
4. **Type Safety**: Use `yarn test:typecheck` to verify TypeScript

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:update     # Run all tests (with snapshot updates)
yarn fix             # Auto-fix formatting and linting issues
```

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration

## Collab backend & collections (fork: MilanBehnam/excalidraw)

- `backend/`: Node 24 server (run TS directly): `auth.ts` (Cognito ID tokens), `store.ts` (users, collections, sharing by email, access checks, versions), `server.ts` (HTTP + socket.io rooms with access checks). DynamoDB + S3.
- `excalidraw-app/auth/`: Cognito sign-up/login from the browser, token in `x-auth-token` (CloudFront drops `Authorization` on GET).
- `excalidraw-app/collections/`: sidebar tab (My collections / Shared with me, sharing, history). A file = collab room (room id = file id, key from the server).
- `excalidraw-app/data/backend.ts`: client for the backend (replaces Firebase for collab rooms).
- Local: `docker compose -f backend/docker-compose.yml up -d --build` (DEV_FAKE_AUTH: any email signs in) + `yarn start` → http://localhost:3001; a second user at http://bob.localhost:3001
- Backend test: `docker compose -f backend/docker-compose.yml exec backend node --test test.ts`
- AWS: `deploy/bootstrap.yml` (one-time roles, done) → `deploy/aws.yml` (stack `excalidraw`, eu-central-1). Live: https://d1mhzhxxlv4u5h.cloudfront.net (CloudFront, since some firewalls block sslip.io). Server auto-deploys pushes to `master` every 5 min. See `deploy/README.md`.
- Remotes: `origin` = fork, `upstream` = excalidraw/excalidraw.
