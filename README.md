# Buckeye Vault

Ohio State football full games and highlights archive with Cloudflare R2 storage integration.

## Deployment on Render
1. Create a new **Web Service** on Render connected to your GitHub repository.
2. Set Build Command: `npm install`
3. Set Start Command: `npm start`
4. Add Environment Variables in Render:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET_NAME`
   - `R2_ENDPOINT`
   - `R2_PUBLIC_DOMAIN`
   - `ADMIN_PASSWORD`
