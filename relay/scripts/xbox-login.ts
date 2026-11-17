// One-time: sign the relay in to an Xbox account (read-only use).
//   npx tsx scripts/xbox-login.ts
// Then open the link, type the code, and sign in with the relay's Xbox account.
import "dotenv/config";
import { XboxClient, pollDeviceLogin, saveToken, startDeviceLogin } from "../src/xbox.js";

const d = await startDeviceLogin();
console.log(`\nOpen ${d.verification_uri} and enter code:  ${d.user_code}\n(waiting up to ${Math.round(d.expires_in / 60)} min)`);
const refresh = await pollDeviceLogin(d.device_code, d.interval, d.expires_in);
saveToken({ refresh });
const x = new XboxClient({ refresh });
const me = await x.me();
saveToken({ refresh, ...me });
console.log(`signed in as ${me.gamertag} (${me.xuid})`);
