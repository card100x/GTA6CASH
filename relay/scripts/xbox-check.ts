import "dotenv/config";
import { XboxClient } from "../src/xbox.js";
const x = new XboxClient();
const KM = "2535418625213019";
try {
  const f = await x.friendsOf(KM);
  console.log(`TheKittyMine friends visible: ${f.length}`);
  const pres = await x.presence(f.map((p) => p.xuid));
  let shown = 0;
  for (const p of f) {
    const g = pres.get(p.xuid);
    if (g) shown++;
    console.log(`${p.gamertag.padEnd(18)} ${p.xuid}  ${g ? "IN GAME: " + g.name + " (" + g.titleId + ")" : (p.presence ?? "-")}`);
  }
  console.log(`in a game right now: ${shown}`);
} catch (e) { console.log("ERR", (e as Error).message); }
