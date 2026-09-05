"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/actions/auth";

/**
 * The staff app shell.
 *
 * Navigation used to be inline links that differed on every page, so where you
 * could go depended on where you happened to be. One drawer, one place, the
 * same on every screen — and the account sits top-right where people look for
 * it rather than buried among the page links.
 */
export interface ShellUser {
  full_name: string;
  role: string;
  course_name: string;
}

interface NavItem { href: string; label: string; hint: string; roles?: string[] }

const NAV: NavItem[] = [
  { href: "/app", label: "Open reports", hint: "What needs doing now" },
  { href: "/app/dashboard", label: "Course status", hint: "Volume, response times, recurring problems", roles: ["manager", "owner"] },
  { href: "/app/staff", label: "Staff", hint: "Add people, roles, departments", roles: ["manager", "owner"] },
  { href: "/app/rules", label: "Routing & SLAs", hint: "Who gets told, and how fast", roles: ["manager", "owner"] },
  { href: "/app/placards", label: "Placards", hint: "Print QR codes for the course", roles: ["manager", "owner", "supervisor"] },
];

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);

  // Close on navigation: a drawer left open over the page you just asked for is
  // the most common thing people complain about in drawer navigation.
  //
  // Adjusted during render rather than in an effect. Doing it in an effect
  // renders the new page with the drawer still open and then immediately
  // renders it again closed, which is both a wasted pass and a visible flash of
  // the old drawer over the new page on a slow phone.
  const [lastPath, setLastPath] = useState(path);
  if (lastPath !== path) {
    setLastPath(path);
    setOpen(false);
    setMenu(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setMenu(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = NAV.filter((n) => !n.roles || n.roles.includes(user.role));

  return (
    <div className="min-h-dvh bg-surface-app text-ink antialiased">
      <header className="sticky top-0 z-30 border-b border-line bg-surface-app/90 backdrop-blur">
        <div className="mx-auto flex max-w-[62rem] items-center justify-between gap-3 px-4 py-3">
          <button
            onClick={() => setOpen(true)}
            aria-label="Menu"
            className="flex h-9 w-9 items-center justify-center rounded-control border border-line"
          >
            <span className="sr-only">Menu</span>
            <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
              <path d="M0 1h16M0 6h16M0 11h16" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>

          <p className="min-w-0 truncate text-[13px] text-ink-muted">{user.course_name}</p>

          <div className="relative">
            <button
              onClick={() => setMenu((m) => !m)}
              className="flex items-center gap-2 rounded-control border border-line px-2.5 py-1.5"
            >
              {/* Initials rather than an avatar: nobody uploads a photo to a
                  work tool, and a broken image is worse than none. */}
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-surface">
                {user.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
              </span>
              <span className="hidden text-[13px] sm:inline">{user.full_name}</span>
            </button>

            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-card border border-line bg-surface-raised py-1.5 shadow-lg">
                  <div className="px-3 py-2">
                    <p className="text-[14px] font-medium">{user.full_name}</p>
                    <p className="mt-0.5 text-[12px] capitalize text-ink-muted">{user.role}</p>
                  </div>
                  <div className="my-1 border-t border-line" />
                  <a href="/account/password" className="block px-3 py-2 text-[14px] text-ink-secondary hover:bg-surface-sunken">
                    Change password
                  </a>
                  <form action={signOut}>
                    <button className="w-full px-3 py-2 text-left text-[14px] text-ink-secondary hover:bg-surface-sunken">
                      Sign out
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Drawer */}
      <div
        className={`fixed inset-0 z-40 transition ${open ? "visible" : "invisible"}`}
        aria-hidden={!open}
      >
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-black/25 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        />
        <nav
          className={`absolute inset-y-0 left-0 w-[17rem] border-r border-line bg-surface-raised
                      transition-transform duration-200 ${open ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="px-5 pt-5 pb-3">
            <p className="text-[11px] uppercase tracking-[0.18em] text-ink-subtle">ProResponse</p>
            <p className="mt-1 text-[15px] font-semibold">{user.course_name}</p>
          </div>
          <ul className="px-2.5 pb-4">
            {items.map((n) => {
              const active = n.href === "/app" ? path === "/app" : path.startsWith(n.href);
              return (
                <li key={n.href}>
                  <a
                    href={n.href}
                    className={`block rounded-control px-3 py-2.5 ${
                      active ? "bg-surface-sunken" : "hover:bg-surface-sunken"
                    }`}
                  >
                    <span className={`block text-[14px] ${active ? "font-semibold" : "font-medium"}`}>
                      {n.label}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-ink-muted">
                      {n.hint}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {children}
    </div>
  );
}
