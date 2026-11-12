// Modified for Triune.
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { getCliServerUrl } from "@/lib/host";
import { quoteShellArgument } from "@/lib/shell";
import { CliCommandBlock } from "./CliCommandBlock";

export function ConnectHostInstructions({
  serverUrl,
  label,
}: {
  serverUrl: string;
  label?: string;
}) {
  const info = useServerInfo();
  // Advertise Lakebox only after the server confirms Databricks support.
  const databricksFeatures = info !== "loading" && info.databricks_features;
  const quotedServerUrl = quoteShellArgument(serverUrl);
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-dashed border-border p-4">
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
      {databricksFeatures ? (
        <Tabs defaultValue="local" componentId="new_chat.host_tabs">
          <TabsList className="w-full">
            <TabsTrigger value="local" className="text-sm">
              Local machine
            </TabsTrigger>
            <TabsTrigger value="lakebox" className="text-sm">
              Databricks Lakebox
            </TabsTrigger>
          </TabsList>
          <TabsContent value="local">
            <CliCommandBlock
              command={`triune host --server ${quotedServerUrl}`}
              testIdPrefix="connect-host"
            />
          </TabsContent>
          <TabsContent value="lakebox" className="flex flex-col gap-1.5">
            <CliCommandBlock
              command="triune sandbox create --provider lakebox"
              testIdPrefix="connect-lakebox-create"
            />
            <CliCommandBlock
              command={`triune sandbox connect --provider lakebox --sandbox-id <id> --server ${quotedServerUrl}`}
              testIdPrefix="connect-lakebox-connect"
            />
          </TabsContent>
        </Tabs>
      ) : (
        <CliCommandBlock
          command={`triune host --server ${quotedServerUrl}`}
          testIdPrefix="connect-host"
        />
      )}
    </div>
  );
}

/** Shared host setup keeps the owning workspace picker and its drafts mounted. */
export function ConnectHostDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        data-testid="connect-host-dialog"
      >
        <DialogHeader>
          <DialogTitle>Connect a host</DialogTitle>
          <DialogDescription>
            Run this on the machine you want to use, then pick it from the host list.
          </DialogDescription>
        </DialogHeader>
        <ConnectHostInstructions serverUrl={getCliServerUrl()} />
      </DialogContent>
    </Dialog>
  );
}
