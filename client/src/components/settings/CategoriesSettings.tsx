import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { Category } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { uid } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NumberInput, Section } from "@/components/workspace/fields";

const ALL = "__all__";

export function CategoriesSettings() {
  const app = useApp();
  const { toast } = useToast();
  const [list, setList] = useState<Category[]>(app.categories);
  const [saving, setSaving] = useState(false);
  useEffect(() => setList(app.categories), [app.categories]);
  const dirty = JSON.stringify(list) !== JSON.stringify(app.categories);
  const set = (i: number, patch: Partial<Category>) => setList(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const save = async () => {
    if (list.some((c) => !c.name.trim())) { toast({ title: "Every category needs a name", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await api("PUT", "/api/categories", list.map((c) => ({ ...c, name: c.name.trim() })));
      await app.refresh();
      toast({ title: "Categories saved" });
    } catch (e) {
      toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" });
    } finally { setSaving(false); }
  };

  return (
    <Section
      title="Rate templates"
      description="Shared rates for a role, like Chef or Server. Employees in a category always use its current rates. Limit a category to one location if rates differ."
      actions={<Button variant="outline" size="sm" onClick={() => setList([...list, { id: uid("c"), name: "", siteId: null, payBasis: "day_rate", fullDayRate: 0, halfDayRate: 0, hourlyRate: 0, isNetPay: true }])} data-testid="button-add-category"><Plus /> Add category</Button>}
    >
      {list.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">No categories yet. Add one for each role that shares a rate.</p> : (
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm min-w-[50rem]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Name</th><th className="pb-2 font-medium">Location</th><th className="pb-2 font-medium">Basis</th>
                <th className="pb-2 font-medium">Full day</th><th className="pb-2 font-medium">Half day</th><th className="pb-2 font-medium">Hourly</th><th className="pb-2 font-medium text-center">Net</th><th />
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => (
                <tr key={c.id} className="border-t border-border/60" data-testid={`row-category-${c.id}`}>
                  <td className="py-2 pr-2"><Input className="h-8" value={c.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Name" data-testid={`input-category-name-${i}`} /></td>
                  <td className="py-2 pr-2 w-44">
                    <Select value={c.siteId ?? ALL} onValueChange={(v) => set(i, { siteId: v === ALL ? null : v })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value={ALL}>All locations</SelectItem>{app.sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </td>
                  <td className="py-2 pr-2 w-32">
                    <Select value={c.payBasis} onValueChange={(v) => set(i, { payBasis: v as any })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="day_rate">Day rate</SelectItem><SelectItem value="hourly">Hourly</SelectItem></SelectContent>
                    </Select>
                  </td>
                  <td className="py-2 pr-2 w-28"><NumberInput className="h-8" prefix={app.prefs.currencySymbol} value={c.fullDayRate} disabled={c.payBasis === "hourly"} onChange={(n) => set(i, { fullDayRate: n })} data-testid={`input-category-full-${i}`} /></td>
                  <td className="py-2 pr-2 w-28"><NumberInput className="h-8" prefix={app.prefs.currencySymbol} value={c.halfDayRate} disabled={c.payBasis === "hourly"} onChange={(n) => set(i, { halfDayRate: n })} /></td>
                  <td className="py-2 pr-2 w-28"><NumberInput className="h-8" prefix={app.prefs.currencySymbol} value={c.hourlyRate} disabled={c.payBasis !== "hourly"} onChange={(n) => set(i, { hourlyRate: n })} /></td>
                  <td className="py-2 text-center"><Switch checked={c.isNetPay} onCheckedChange={(v) => set(i, { isNetPay: v })} aria-label="Net pay" /></td>
                  <td className="py-2 text-right"><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Remove category" onClick={() => setList(list.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {dirty && <span className="mr-auto basis-full text-xs text-muted-foreground sm:basis-auto">Unsaved changes · employees using a removed category fall back to Custom</span>}
        <Button variant="outline" disabled={!dirty || saving} onClick={() => setList(app.categories)}>Discard</Button>
        <Button disabled={!dirty || saving} onClick={save} data-testid="button-save-categories">{saving && <Loader2 className="animate-spin" />}Save categories</Button>
      </div>
    </Section>
  );
}
