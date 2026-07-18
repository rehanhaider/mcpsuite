/** Debounced search input for list filter bars. */
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "~/components/ui/input";

export function DebouncedInput(props: {
  value: string;
  onDebounced(value: string): void;
  placeholder?: string;
  delay?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(props.value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastPushed = useRef(props.value);

  // Sync down external resets (e.g. cleared filters).
  useEffect(() => {
    if (props.value !== lastPushed.current) {
      setDraft(props.value);
      lastPushed.current = props.value;
    }
  }, [props.value]);

  return (
    <label
      className={`flex h-8 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/20 ${props.className ?? "min-w-64 flex-1"}`}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
      <Input
        type="search"
        className="h-auto min-w-0 grow rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        placeholder={props.placeholder ?? "Filter…"}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            lastPushed.current = v;
            props.onDebounced(v);
          }, props.delay ?? 250);
        }}
      />
    </label>
  );
}
