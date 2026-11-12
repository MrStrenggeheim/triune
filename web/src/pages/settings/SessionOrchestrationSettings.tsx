import { useId } from "react";
import { SettingsGroup } from "@/components/SettingsGroup";
import { SettingsLabel } from "@/components/SettingsLabel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSessionOrchestrationPreference } from "@/hooks/useSessionOrchestrationPreference";

export function SessionOrchestrationSettings() {
  const preference = useSessionOrchestrationPreference();
  const labelId = useId();
  const descriptionId = useId();
  const statusId = useId();
  if (preference.data === null) return null;

  const administratorDisabled = preference.data?.server_enabled === false;
  return (
    <SettingsGroup title="Agents" testId="settings-group-agents">
      <div className="flex items-start justify-between gap-6">
        <SettingsLabel
          label="Agent communication"
          labelId={labelId}
          descriptionId={descriptionId}
          className="flex-1"
          description="Allow your agents to message other chats and create independent worker chats. Changes take effect immediately. Ordinary subagents are unaffected."
          descriptionClassName="text-ui"
        />
        <Switch
          aria-labelledby={labelId}
          aria-describedby={`${descriptionId} ${statusId}`}
          checked={preference.data?.enabled ?? true}
          disabled={
            !preference.data ||
            preference.isFetching ||
            preference.isSaving ||
            preference.isError ||
            administratorDisabled
          }
          onCheckedChange={preference.save}
          className="mt-0.5 shrink-0"
          componentId="settings.general.agent_communication"
        />
      </div>
      <div id={statusId}>
        {administratorDisabled && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Disabled by your server administrator. Your personal preference is retained.
          </p>
        )}
        {(preference.isPending || preference.isSaving) && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {preference.isSaving ? "Saving…" : "Loading…"}
          </p>
        )}
        {preference.error && (
          <div className="mt-2 flex items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load agent communication: {preference.error.message}
            </p>
            <Button variant="outline" size="sm" onClick={() => void preference.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {preference.saveError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Could not save agent communication: {preference.saveError.message}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
