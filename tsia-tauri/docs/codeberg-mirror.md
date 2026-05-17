# Codeberg → GitHub mirror setup

One-time setup so releases build on GitHub Actions while Codeberg stays
canonical.

## 1. Create the GitHub repo

- Same name as the Codeberg one (`tsia`).
- Public or private — either works.
- Don't initialise with README/licence (we'll push existing history).
- After creation: Settings → General → Features → uncheck Issues,
  Discussions, Wiki. Keep Releases on.

## 2. Create a GitHub personal access token

- GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained tokens → Generate new token.
- Resource owner: your account.
- Repository access: Only select repositories → pick `tsia`.
- Permissions: Contents = Read and write. Nothing else.
- Expiry: 1 year is fine.
- Copy the token immediately; it's shown once.

## 3. Configure the push mirror on Codeberg

- Codeberg repo → Settings → Mirror Settings → "Push to a remote
  repository".
- Repository URL: `https://github.com/YOUR_USERNAME/tsia.git`
- Authentication username: your GitHub username.
- Authentication password: the token from step 2.
- Sync interval: 8h is fine for normal commits. Tags are pushed
  immediately.
- Click **Add**.

## 4. Test it

```bash
git commit --allow-empty -m "test mirror sync"
git push
```

After up to 8h, the commit should appear on GitHub. To force a sync sooner:
on the Codeberg mirror settings page, click **Synchronize Now**.

## 5. Tag triggers Actions

```bash
git tag v0.1.1
git push origin v0.1.1
```

Tags push immediately (Codeberg's mirror doesn't wait for the interval).
GitHub Actions sees the tag, runs the release workflow, drafts a Release.

## Notes

- The mirror is **one-way** (Codeberg → GitHub). Anything pushed directly
  to GitHub will be overwritten on next sync. This is what you want.
- If you ever need to reset: delete the GitHub repo, recreate, re-add the
  mirror config. Codeberg pushes everything from scratch.
- GitHub Actions can also be triggered manually (Actions tab → Release →
  Run workflow) without a tag, useful for debugging the workflow.
