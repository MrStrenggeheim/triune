// Modified for Triune.
import { OperationStatus } from "@/components/ui/loading";
import { useState } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { RoutingModelSelect, MODEL_SELECT_DEFAULT } from "@/components/HarnessConfigControls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHosts, useHostModelOptions } from "@/hooks/useHosts";
import { NATIVE_CODING_AGENTS } from "@/lib/nativeCodingAgents";
import { CLAUDE_NATIVE_MODELS } from "@/lib/claudeNativeModels";
import { readDefaultModels, writeDefaultModel } from "@/lib/defaultModelPreferences";

const REMEMBERED = "__remembered__";
const MODEL_HARNESSES = NATIVE_CODING_AGENTS.filter((agent) =>
  ["claude-native", "codex-native", "pi-native", "devin-native"].includes(agent.harness),
);

/** A model preference belongs to its harness, independently of the default agent. */
export function DefaultModelSettings() {
  const [harness, setHarness] = useState("codex-native");
  const [hostId, setHostId] = useState<string | null>(null);
  const [defaults, setDefaults] = useState(readDefaultModels);
  const [saveFailed, setSaveFailed] = useState(false);
  const hosts = useHosts();
  const catalogHost =
    hostId ?? hosts.data?.find((host) => host.status === "online")?.host_id ?? null;
  const catalog = useHostModelOptions(catalogHost, harness, catalogHost !== null, { poll: false });
  const models =
    catalog.data?.map((model) => ({ id: model.id, label: model.displayName ?? model.id })) ??
    (harness === "claude-native" ? CLAUDE_NATIVE_MODELS : []);
  const saved = defaults[harness];
  const missing = !!saved && !models.some((model) => model.id === saved);
  const save = (choice: string) => {
    const model = choice === REMEMBERED ? undefined : choice === MODEL_SELECT_DEFAULT ? "" : choice;
    if (!writeDefaultModel(harness, model)) {
      setSaveFailed(true);
      return;
    }
    setDefaults(readDefaultModels());
    setSaveFailed(false);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="settings-default-models">
      <SettingsLabel
        label="Default models"
        description="Choose independently for each harness. Project model defaults and explicit choices take priority; unavailable saved models use the harness default."
      />
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Select value={harness} onValueChange={setHarness}>
          <SelectTrigger aria-label="Model default harness">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_HARNESSES.map((agent) => (
              <SelectItem key={agent.harness} value={agent.harness}>
                {agent.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RoutingModelSelect
          value={saved === undefined ? REMEMBERED : saved || MODEL_SELECT_DEFAULT}
          onValueChange={save}
          offerSmartRouting={false}
          testId="settings-default-model"
          ariaLabel="Default model"
          models={models}
          defaultLabel="Harness default"
        >
          <SelectItem value={REMEMBERED}>Use last selected model</SelectItem>
          {missing && (
            <SelectItem value={saved}>{saved} · unavailable; uses harness default</SelectItem>
          )}
        </RoutingModelSelect>
      </div>
      {!!hosts.data?.length && (
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className="shrink-0">Model catalog from</span>
          <Select value={catalogHost ?? "__none__"} onValueChange={setHostId}>
            <SelectTrigger aria-label="Model catalog host" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hosts.data.map((host) => (
                <SelectItem key={host.host_id} value={host.host_id}>
                  {host.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {catalog.isFetching && (
        <OperationStatus className="text-xs">Loading model catalog…</OperationStatus>
      )}
      {(catalog.error || !models.length) && (
        <p role="status" className="text-xs text-muted-foreground">
          Connect a host with this harness to choose a model. Saved preferences remain available.
        </p>
      )}
      {saveFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not save the model default.
        </p>
      )}
    </div>
  );
}
