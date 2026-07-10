import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { FlaskConical, GitCompareArrows, ListChecks, Moon, SearchCheck, Sun } from "lucide-react";
import { models } from "@/lib/data";
import { cn, modelColorVar } from "@/lib/utils";

const sections = [
  { to: "/", label: "Overview", icon: FlaskConical, end: true },
  { to: "/auto-review", label: "Auto-Review", icon: ListChecks },
  { to: "/independent-review", label: "Independent review", icon: SearchCheck },
  { to: "/comparisons", label: "Comparisons", icon: GitCompareArrows },
];

export function Layout() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1400px]">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-hairline px-4 py-6 md:flex">
        <div className="mb-8">
          <p className="font-mono text-[0.65rem] tracking-[0.2em] text-ink-3 uppercase">Checkout-Surge</p>
          <p className="mt-1 text-lg leading-tight font-semibold tracking-tight">Results bench</p>
        </div>

        <nav className="flex flex-col gap-0.5" aria-label="Sections">
          {sections.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
                  isActive ? "bg-wash font-medium text-ink" : "text-ink-2 hover:bg-wash hover:text-ink",
                )
              }
            >
              <Icon aria-hidden className="size-4 text-ink-3" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-8">
          <p className="mb-2 px-2.5 font-mono text-[0.65rem] tracking-[0.2em] text-ink-3 uppercase">Agents</p>
          <nav className="flex flex-col gap-0.5" aria-label="Agent reports">
            {models.map((model) => (
              <NavLink
                key={model.id}
                to={`/models/${model.id}`}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
                    isActive ? "bg-wash font-medium text-ink" : "text-ink-2 hover:bg-wash hover:text-ink",
                  )
                }
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-[3px]"
                  style={{ background: modelColorVar(model.id) }}
                />
                {model.name}
                <span className="ml-auto font-mono text-[0.65rem] text-ink-3">{model.effort}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="mt-auto pt-6">
          <ThemeToggle />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-8 md:px-10">
        <MobileNav />
        <Outlet />
      </main>
    </div>
  );
}

function MobileNav() {
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-1.5 md:hidden" aria-label="Sections">
      {[
        ...sections.map(({ to, label, end }) => ({ to, label, end: end ?? false })),
        ...models.map((m) => ({ to: `/models/${m.id}`, label: m.name, end: false })),
      ].map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "rounded-full border px-2.5 py-1 text-xs",
              isActive ? "border-ink-2 bg-ink text-paper" : "border-hairline text-ink-2",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
      <span className="ml-auto">
        <ThemeToggle compact />
      </span>
    </nav>
  );
}

function ThemeToggle({ compact }: { compact?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((v) => !v)}
      className={cn(
        "flex items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-2",
        "hover:bg-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
      )}
    >
      {dark ? <Sun aria-hidden className="size-3.5" /> : <Moon aria-hidden className="size-3.5" />}
      {!compact && (dark ? "Light theme" : "Dark theme")}
    </button>
  );
}
