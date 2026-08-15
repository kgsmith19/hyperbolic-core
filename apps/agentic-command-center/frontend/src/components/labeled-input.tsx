import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Shared by Spending and Kernel — both pages are one label + one text input,
// repeated per field, and differ only in whether the field is full-width.
export function LabeledInput(
  { id, label, value, onChange, wide }:
  { id: string; label: string; value: string; onChange: (v: string) => void; wide?: boolean }
) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input id={id} className={wide ? "max-w-md" : "w-28"} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
