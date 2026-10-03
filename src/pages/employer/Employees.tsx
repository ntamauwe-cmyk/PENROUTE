import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DashboardShell } from "@/components/DashboardShell";
import { ClayTable, LoadingBlock, PageHeader } from "@/components/pension-ui";
import { Landmark, Pencil, Plus, Search, UserX, UserCheck } from "lucide-react";
import { toast } from "sonner";

interface EmployeeRow {
  _id: string;
  fullName: string;
  employeeCode: string;
  pensionPin: string;
  pfaId: string;
  pfaName: string;
  active: boolean;
}

const EMPTY_FORM = { fullName: "", employeeCode: "", pensionPin: "", pfaId: "" };

export default function Employees() {
  const employees = useQuery(api.pension.listEmployerEmployees);
  const pfas = useQuery(api.pension.listPfas) ?? [];
  const addEmployee = useMutation(api.pension.addEmployee);
  const updateEmployee = useMutation(api.pension.updateEmployee);
  const toggleActive = useMutation(api.pension.toggleEmployeeActive);

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(
    () =>
      (employees ?? []).filter(
        (e: any) =>
          e.fullName.toLowerCase().includes(search.toLowerCase()) ||
          e.pensionPin.toLowerCase().includes(search.toLowerCase()) ||
          e.employeeCode.toLowerCase().includes(search.toLowerCase()),
      ),
    [employees, search],
  );

  const openAdd = () => {
    setForm({ ...EMPTY_FORM });
    setEditing(null);
    setAddOpen(true);
  };

  const openEdit = (e: EmployeeRow) => {
    setForm({
      fullName: e.fullName,
      employeeCode: e.employeeCode,
      pensionPin: e.pensionPin,
      pfaId: e.pfaId,
    });
    setEditing(e);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editing) {
        await updateEmployee({
          employeeId: editing._id as any,
          fullName: form.fullName,
          employeeCode: form.employeeCode,
          pensionPin: form.pensionPin,
          pfaId: form.pfaId as any,
        });
        toast.success(`${form.fullName} updated`);
        setEditing(null);
      } else {
        await addEmployee({
          fullName: form.fullName,
          employeeCode: form.employeeCode,
          pensionPin: form.pensionPin,
          pfaId: form.pfaId as any,
        });
        toast.success(`${form.fullName} added to the roster`);
        setAddOpen(false);
      }
      setForm({ ...EMPTY_FORM });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save employee");
    } finally {
      setSaving(false);
    }
  };

  const formFields = (
    <div className="space-y-4">
      <div>
        <Label>Full name</Label>
        <Input
          className="mt-1.5"
          value={form.fullName}
          onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
          placeholder="Chinedu Eze"
        />
      </div>
      <div>
        <Label>Employee ID</Label>
        <Input
          className="mt-1.5"
          value={form.employeeCode}
          onChange={(e) => setForm((f) => ({ ...f, employeeCode: e.target.value }))}
          placeholder="RAE-EMP-025"
        />
      </div>
      <div>
        <Label>Pension PIN (RSA)</Label>
        <Input
          className="mt-1.5"
          value={form.pensionPin}
          onChange={(e) => setForm((f) => ({ ...f, pensionPin: e.target.value }))}
          placeholder="PIN100123"
        />
      </div>
      <div>
        <Label>PFA</Label>
        <Select
          value={form.pfaId}
          onValueChange={(v) => setForm((f) => ({ ...f, pfaId: v }))}
        >
          <SelectTrigger className="mt-1.5 w-full cursor-pointer">
            <SelectValue placeholder="Select PFA" />
          </SelectTrigger>
          <SelectContent>
            {/* Inactive PFAs are not selectable for new/changed assignments,
                except the employee's current (possibly deactivated) PFA. */}
            {(pfas as any[])
              .filter(
                (p) =>
                  (p.active !== false && p.status !== "INACTIVE") || p._id === form.pfaId,
              )
              .map((p) => (
                <SelectItem key={p._id} value={p._id}>
                  {p.name} ({p.code})
                  {p.active === false || p.status === "INACTIVE" ? " — inactive" : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  const saveDisabled = saving || !form.fullName || !form.employeeCode || !form.pensionPin || !form.pfaId;

  return (
    <DashboardShell>
      <PageHeader
        title="Employees"
        description="Your pension roster — every employee needs a valid RSA PIN and PFA before contributions."
        actions={
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button className="font-semibold" onClick={openAdd}>
                <Plus className="size-4" /> Add employee
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add employee</DialogTitle>
                <DialogDescription>
                  The pension PIN is validated against PENCOM rules and checked for duplicates.
                </DialogDescription>
              </DialogHeader>
              {formFields}
              <DialogFooter className="mt-4">
                <Button className="font-semibold w-full sm:w-auto" onClick={handleSave} disabled={saveDisabled}>
                  {saving ? "Saving…" : "Add employee"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by name, PIN or employee ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit employee</DialogTitle>
            <DialogDescription>
              Update details or move this employee to a different PFA. Changes are recorded in the
              audit trail and apply from the next contribution.
            </DialogDescription>
          </DialogHeader>
          {formFields}
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setEditing(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button className="font-semibold w-full sm:w-auto" onClick={handleSave} disabled={saveDisabled}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!employees ? (
        <LoadingBlock label="Loading roster…" />
      ) : (
        <ClayTable
          headers={["Employee", "Employee ID", "Pension PIN", "PFA", "Status", ""]}
          isEmpty={filtered.length === 0}
          emptyMessage={
            employees.length === 0
              ? "No employees yet — add your first employee to start contributing."
              : "No employees match your search."
          }
        >
          {filtered.map((e: any) => (
            <tr key={e._id} className="pen-table-row">
              <td className="px-3 py-2.5 font-medium">{e.fullName}</td>
              <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{e.employeeCode}</td>
              <td className="px-3 py-2.5 tabular-nums">{e.pensionPin}</td>
              <td className="px-3 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Landmark className="size-3.5" /> {e.pfaName}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <Badge
                  variant="secondary"
                  className={e.active ? "bg-[#E6F6EF] text-[#04593A]" : "bg-[#EEF1F3] text-[#4B5C66]"}
                >
                  {e.active ? "Active" : "Inactive"}
                </Badge>
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(e as EmployeeRow)}
                  >
                    <Pencil className="size-4" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await toggleActive({ employeeId: e._id });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Update failed");
                      }
                    }}
                  >
                    {e.active ? (
                      <>
                        <UserX className="size-4" /> Deactivate
                      </>
                    ) : (
                      <>
                        <UserCheck className="size-4" /> Reactivate
                      </>
                    )}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </ClayTable>
      )}
    </DashboardShell>
  );
}
