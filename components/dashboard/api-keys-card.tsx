"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";

interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export function ApiKeysCard() {
  const toast = useToast();
  const [items, setItems] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: ApiKeyItem[] }>("/api/v1/api-keys");
      setItems(res.items);
    } catch (err) {
      toast.error("Could not load API keys", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name required", "Give this key a short label.");
      return;
    }
    setCreating(true);
    try {
      const res = await api<{ id: string; name: string; prefix: string; createdAt: string; key: string }>("/api/v1/api-keys", {
        method: "POST",
        body: { name: trimmed },
      });
      setCreatedKey(res.key);
      setName("");
      toast.success("API key created", "Copy it now — it will not be shown again.");
      await load();
    } catch (err) {
      toast.error("Could not create key", err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(id);
    try {
      await api(`/api/v1/api-keys/${id}`, { method: "DELETE" });
      toast.success("API key revoked");
      await load();
    } catch (err) {
      toast.error("Could not revoke key", err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(null);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed", "Select the key and copy it manually.");
    }
  }

  return (
    <Card>
      <CardHeader
        title="Send API keys"
        description="Let other applications send mail through your connected Gmail/SMTP account. Use Authorization: Bearer srots_… on POST /api/v1/send."
      />
      <CardBody className="space-y-4">
        {createdKey ? (
          <Alert tone="warning" title="Copy your new API key now">
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="break-all rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-fg">{createdKey}</code>
              <Button type="button" size="sm" variant="secondary" onClick={() => void copyKey()}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreatedKey(null)}>
                Dismiss
              </Button>
            </div>
          </Alert>
        ) : null}

        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Field label="Key name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM integration" maxLength={80} />
            </Field>
          </div>
          <Button type="submit" disabled={creating}>
            <Plus className="h-4 w-4" />
            {creating ? "Creating…" : "Create key"}
          </Button>
        </form>

        {loading ? (
          <p className="type-caption text-muted">Loading keys…</p>
        ) : items.length === 0 ? (
          <p className="type-body-sm text-muted">No active API keys yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-fg">
                    <KeyRound className="h-3.5 w-3.5 text-muted" />
                    {item.name}
                    <Badge tone="neutral">{item.prefix}…</Badge>
                  </p>
                  <p className="type-hint mt-0.5 text-subtle">
                    Created {new Date(item.createdAt).toLocaleString()}
                    {item.lastUsedAt ? ` · Last used ${new Date(item.lastUsedAt).toLocaleString()}` : " · Never used"}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" disabled={revoking === item.id} onClick={() => void handleRevoke(item.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
