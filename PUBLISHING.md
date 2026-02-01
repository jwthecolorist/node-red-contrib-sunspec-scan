# How to Publish to NPM

This guide details the steps to publish `node-red-contrib-sunspec-scan` to the NPM registry.

## Prerequisites

1.  **NPM Account**: You must have an account on [npmjs.com](https://www.npmjs.com/).
2.  **Terminal Access**: You need access to the command line.

## Steps

### 1. Login to NPM

Run the following command in your terminal. You will be prompted for your username, password, and email. You may also need to provide a 2FA OTP.

```bash
npm login
```

### 2. Verify Package Content

Ensure `package.json` has the correct version and metadata.

- **Current Version**: `1.2.0`
- **Name**: `node-red-contrib-sunspec-scan`

### 3. Publish

Run the publish command.

```bash
npm publish
```

**Note**: If you have 2FA enabled, you will be prompted for an OTP again.

### 4. Verification

Once published, the package will be available at:
`https://www.npmjs.com/package/node-red-contrib-sunspec-scan`

It will also strictly appear in the Node-RED Library (flows.nodered.org) after a short delay (usually 15-30 minutes) as they index NPM keywords.

## Troubleshooting

- **403 Forbidden**: You do not have permission to publish this package name.
  - _Solution_: Check if the name `node-red-contrib-sunspec-scan` is already taken on NPM. If it is, and you don't own it, you must change the `name` in `package.json` (e.g., `@jwthecolorist/node-red-contrib-sunspec-scan`).
- **402 Payment Required**: You are trying to publish a private package without a paid account.
  - _Solution_: Run `npm publish --access public`.

## Future Updates

1.  Make your code changes.
2.  Update `CHANGELOG.md`.
3.  Bump version: `npm version patch` (1.2.1) or `npm version minor` (1.3.0).
4.  Push to GitHub: `git push && git push --tags`.
5.  Publish: `npm publish`.
