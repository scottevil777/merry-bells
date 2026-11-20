# Cloudflare setup for Merry Bells

The site remains a static HTML app. A Cloudflare Worker checks the shared code and serves the library API, R2 stores the original MIDI/MusicXML files, and D1 stores parsed song data and metadata. The shared code is a convenience gate, not strong authentication; everyone with the code can see and add to the same library.

## Create and deploy the backend

Run these commands from the `cloudflare` directory:

1. Install Wrangler if needed and sign in:

   ```sh
   npx wrangler login
   ```

2. Create the private R2 bucket:

   ```sh
   npx wrangler r2 bucket create merry-bells-midi-library
   ```

3. Create the D1 database:

   ```sh
   npx wrangler d1 create merry-bells-library
   ```

   Copy the returned database ID into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

4. Apply the schema and set the shared code as a Worker secret:

   ```sh
   npx wrangler d1 migrations apply merry-bells-library --remote
   npx wrangler secret put MERRY_BELLS_ACCESS_CODE
   ```

   Wrangler prompts for the code without putting it in the command history. Do not commit the code.

5. Deploy the API:

   ```sh
   npx wrangler deploy
   ```

## Connect the page

Set `CLOUDFLARE_API_URL` near the start of the script in `merry_bells.html` to the Worker URL printed after deploy, for example `https://merry-bells-library.<your-account>.workers.dev`. Publish the updated HTML to the site's existing host. Then choose **Unlock Shared Library**, enter the shared code, upload a MIDI file, and reload to confirm it persists.

To publish this repository as a site, create a **Pages** project from the GitHub repository, select no framework/build command, and set the build output directory to `.` (the repository root). `_redirects` sends the site root to `merry_bells.html`. Deploy the branch containing these changes; future pushes can then trigger Pages deployments.

Uploads are limited to 4 MB. R2 holds the original file; D1 holds its parsed notes, tempo, and song metadata. Optional backing-track path and synchronization fields are included in the schema for later audio upload/playback work; this initial backend does not upload or play backing tracks.

Anyone with the shared code can view and add songs. This setup has no user accounts, per-user access, rate limiting, or strong security; do not use it for sensitive files.
