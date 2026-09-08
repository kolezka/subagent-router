// STANDALONE DEMO PLUGIN — this is NOT subagent-router's actual adapter/router
// code. It exists only to prove the native `tool.execute.before` hook mechanism
// (registration, args shape, throw-to-deny semantics) works against a real
// opencode build. It hardcodes two subagent_type values to deny; it does not
// consult subagent-router's config, catalog, or capability profile. Passing
// this probe proves the OpenCode hook contract; it proves nothing about
// subagent-router's own adapter or about M6-runtime for that adapter.
import { appendFileSync } from "node:fs";

const LOG = "/tmp/oc_trial/plugin.log";
function log(msg) {
  appendFileSync(LOG, msg + "\n");
}

export const DenyPlugin = async (pluginInput) => {
  log("plugin loaded");
  return {
    "tool.execute.before": async (input, output) => {
      log("tool.execute.before called tool=" + input.tool + " args=" + JSON.stringify(output.args));
      if (input.tool === "task") {
        const subagentType = output.args?.subagent_type;
        if (subagentType === "reviewer@ghost" || subagentType === "nobody") {
          log("DENYING via throw for subagent_type=" + subagentType);
          throw new Error("subagent-router: unknown-model (" + subagentType + ")");
        }
      }
      log("allowing tool=" + input.tool);
    },
  };
};
