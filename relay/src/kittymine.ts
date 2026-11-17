// Reader for KittyMine's public explorer API (thekittymine.com).
// Only public, read-only endpoints. We never need anyone's password.

export const KITTYMINE_BASE = process.env.KITTYMINE_BASE ?? "https://www.thekittymine.com";

export type SourceType = "Steam" | "Xbox" | "Legacy" | string;

export interface NetworkBlock {
  height: number;
  hash: string; // 64-hex winner proof, used as our draw seed
  winner: string; // SteamID64 / XUID / legacy name
  producer: string | null; // source account (Steam KittyMineCoin, Xbox TheKittyMine)
  source: SourceType;
  timestamp: number; // ms, as observed by the oracle
  raw?: string; // full block line (carries any transactions)
  txCount?: number;
}

interface RawBlock {
  height: string;
  hash: string;
  miner: string;
  timestamp: string;
  rawLine?: string;
  txCount?: number;
  metadata?: { producerId?: string; sourceType?: string; winnerId?: string; observedAt?: number };
}

export function parseBlock(b: RawBlock): NetworkBlock {
  return {
    height: Number(b.height),
    hash: b.hash,
    winner: b.metadata?.winnerId ?? b.miner,
    producer: b.metadata?.producerId ?? null,
    source: b.metadata?.sourceType ?? "Legacy",
    timestamp: Number(b.metadata?.observedAt ?? b.timestamp),
    raw: b.rawLine,
    txCount: b.txCount,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(KITTYMINE_BASE + path, {
    headers: { accept: "application/json", "user-agent": "kmc-launchpad-relay/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`KittyMine ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Latest blocks, newest first. `cursor` pages backwards (exclusive). */
export async function fetchBlocks(limit = 50, cursor?: number): Promise<{ blocks: NetworkBlock[]; next: number | null }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", String(cursor));
  const r = await getJson<{ blocks: RawBlock[]; nextCursor?: string | null }>(`/api/network-blocks?${q}`);
  return { blocks: r.blocks.map(parseBlock), next: r.nextCursor ? Number(r.nextCursor) : null };
}

/** All blocks with height > afterHeight, oldest first (pages back at most `maxPages`). */
export async function fetchBlocksAfter(afterHeight: number, maxPages = 5): Promise<NetworkBlock[]> {
  const out: NetworkBlock[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { blocks, next } = await fetchBlocks(50, cursor);
    out.push(...blocks.filter((b) => b.height > afterHeight));
    if (!next || blocks.length === 0 || blocks[blocks.length - 1].height <= afterHeight) break;
    cursor = next;
  }
  const seen = new Set<number>();
  return out
    .filter((b) => (seen.has(b.height) ? false : (seen.add(b.height), true)))
    .sort((a, b) => a.height - b.height);
}

export interface Summary {
  latestHeight: number;
  validators: number;
  players: number;
}

export async function fetchSummary(): Promise<Summary> {
  const r = await getJson<{ blocks: { latestHeight: number }; validators: { active: number }; players: { total: number } }>(
    "/api/explorer/summary",
  );
  return { latestHeight: r.blocks.latestHeight, validators: r.validators.active, players: r.players.total };
}
