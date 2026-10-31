import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type PfaOption = {
  _id: string;
  name: string;
  code: string;
  shortName?: string;
  active?: boolean;
  status?: string;
};

/**
 * Searchable PFA selector: type any part of a PFA's name, short name or
 * code (e.g. "st" → Stanbic IBTC) to narrow the list. Inactive PFAs are
 * hidden unless they are the current value (historical records).
 */
export function PfaPicker({
  pfas,
  value,
  onChange,
  id,
}: {
  pfas: PfaOption[];
  value: string;
  onChange: (pfaId: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selectable = useMemo(
    () =>
      pfas
        .filter((p) => (p.active !== false && p.status !== "INACTIVE") || p._id === value)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pfas, value],
  );
  const term = q.trim().toLowerCase();
  const matches = term
    ? selectable
        .filter((p) =>
          [p.name, p.shortName ?? "", p.code].some((s) => s.toLowerCase().includes(term)),
        )
        // Names that START with the typed letters come first.
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(term)) - Number(!b.name.toLowerCase().startsWith(term)))
    : selectable;
  const current = pfas.find((p) => p._id === value);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          className="mt-1.5 flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs"
        >
          <span className={current ? "truncate" : "truncate text-muted-foreground"}>
            {current ? `${current.name} (${current.code})` : "Search or select a PFA"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            autoFocus
            aria-label="Search PFAs"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Type to search, e.g. “st” or “leadway”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                e.preventDefault();
                onChange(matches[0]._id);
                setOpen(false);
                setQ("");
              }
            }}
          />
        </div>
        <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No PFA matches “{q}”.</li>
          ) : (
            matches.map((p) => (
              <li key={p._id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={p._id === value}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onChange(p._id);
                    setOpen(false);
                    setQ("");
                  }}
                >
                  <Check className={`size-4 shrink-0 ${p._id === value ? "opacity-100" : "opacity-0"}`} />
                  <span className="flex-1">
                    {p.name} <span className="text-muted-foreground">({p.code})</span>
                    {(p.active === false || p.status === "INACTIVE") && (
                      <span className="text-muted-foreground"> — inactive</span>
                    )}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
