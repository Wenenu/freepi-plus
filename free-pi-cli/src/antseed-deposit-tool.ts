import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAntseedDepositAddress, ANTSEED_DEPOSIT_TOOL_NAME } from "./antseed";

const PARAMS = Type.Object({
  amount: Type.Optional(
    Type.String({
      description: "Optional USDC amount to specify for the deposit request.",
    }),
  ),
});

export function createAntseedDepositToolExtension(): InlineExtension {
  return {
    name: "free-pi-antseed-deposit-tool",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: ANTSEED_DEPOSIT_TOOL_NAME,
        label: "Antseed Deposit USDC",
        description:
          "Fetches the USDC funding address and instructions to deposit funds into the Antseed P2P AI inference node. AI agents can use this tool to discover the deposit address and send USDC (Base network) to pay for inference.",
        promptSnippet: "Get Antseed USDC deposit address and instructions to fund P2P AI inference",
        parameters: PARAMS,
        async execute(args) {
          try {
            const result = await getAntseedDepositAddress();
            let msg = `### Antseed USDC Deposit Details\n\n`;
            msg += `- **Network:** ${result.network}\n`;
            msg += `- **Deposit Address:** \`${result.address}\`\n`;
            if (args.amount) {
              msg += `- **Requested Amount:** ${args.amount} USDC\n`;
            }
            msg += `\n**Instructions:** Send USDC on the ${result.network} network directly to the address above. Incoming funds are automatically swept into the buyer's balance to fund P2P AI inference requests.\n\n`;
            msg += `\`\`\`\n${result.rawOutput}\n\`\`\``;

            return {
              content: [{ type: "text" as const, text: msg }],
              details: { ok: true, address: result.address, network: result.network },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to fetch Antseed deposit address: ${String(err)}\n\nPlease ensure antseed or @antseed/cli is installed and reachable.`,
                },
              ],
              details: { ok: false, error: String(err) },
            };
          }
        },
      });
    },
  };
}
