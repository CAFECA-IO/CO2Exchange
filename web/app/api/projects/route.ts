import { registryAbi, registryWriteAbi } from "@/lib/abis";
import { deployment, isAddress, publicClient } from "@/lib/server/chain";

/// GET [?owner=] → 專案清單（鏈上）
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner");
  const d = deployment();
  const next = await publicClient.readContract({ address: d.carbonRegistry, abi: registryWriteAbi, functionName: "nextProjectId" });
  const out = [];
  for (let i = 1n; i < next; i++) {
    const p = await publicClient.readContract({ address: d.carbonRegistry, abi: registryAbi, functionName: "projectOf", args: [i] });
    if (isAddress(owner) && p.owner.toLowerCase() !== owner.toLowerCase()) continue;
    out.push({ projectId: Number(i), owner: p.owner, name: p.name, methodology: p.methodology, location: p.location, metadataURI: p.metadataURI, active: p.active });
  }
  return Response.json({ projects: out });
}
