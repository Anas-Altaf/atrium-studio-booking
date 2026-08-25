import {
  Activity,
  Banknote,
  Building2,
  CalendarCheck,
  DoorOpen,
  LayoutDashboard,
  Package,
  Percent,
  ScrollText,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Role } from "@/lib/api";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: Role[];
  section: "Book" | "Venue" | "Platform" | "Account";
}

/**
 * What each role is shown. Not what each role may do — the API decides that,
 * and typing a hidden URL still ends in a 403 or a 404.
 *
 * Staff see rooms and equipment because they manage bookings against them; the
 * write controls on those pages are hidden for them and refused server-side.
 */
export const NAV: NavItem[] = [
  {
    href: "/search",
    label: "Find a room",
    icon: Search,
    section: "Book",
    roles: ["CUSTOMER", "PLATFORM_ADMIN"],
  },
  {
    href: "/bookings",
    label: "My bookings",
    icon: CalendarCheck,
    section: "Book",
    roles: ["CUSTOMER"],
  },
  {
    href: "/console",
    label: "Dashboard",
    icon: LayoutDashboard,
    section: "Venue",
    roles: ["VENUE_STAFF", "VENUE_ADMIN"],
  },
  {
    href: "/console/bookings",
    label: "Bookings",
    icon: CalendarCheck,
    section: "Venue",
    roles: ["VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/rooms",
    label: "Rooms",
    icon: DoorOpen,
    section: "Venue",
    roles: ["VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/equipment",
    label: "Equipment",
    icon: Package,
    section: "Venue",
    roles: ["VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/policy",
    label: "Refund policy",
    icon: Percent,
    section: "Venue",
    roles: ["VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/staff",
    label: "Staff",
    icon: Users,
    section: "Venue",
    roles: ["VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/settings",
    label: "Venue settings",
    icon: Building2,
    section: "Venue",
    roles: ["VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/reports",
    label: "Revenue",
    icon: Banknote,
    section: "Platform",
    roles: ["VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/console/reconciliation",
    label: "Reconciliation",
    icon: ScrollText,
    section: "Platform",
    roles: ["VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    href: "/admin/venues",
    label: "All venues",
    icon: Building2,
    section: "Platform",
    roles: ["PLATFORM_ADMIN"],
  },
  {
    href: "/admin/ops",
    label: "Ops",
    icon: Activity,
    section: "Platform",
    roles: ["PLATFORM_ADMIN"],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    section: "Account",
    roles: ["CUSTOMER", "VENUE_STAFF", "VENUE_ADMIN", "PLATFORM_ADMIN"],
  },
];

export const navFor = (role: Role) => NAV.filter((i) => i.roles.includes(role));

/** Where each role lands after signing in. */
export const homeFor = (role: Role): string =>
  role === "CUSTOMER"
    ? "/search"
    : role === "PLATFORM_ADMIN"
      ? "/admin/venues"
      : "/console";

export const ROLE_LABEL: Record<Role, string> = {
  CUSTOMER: "Customer",
  VENUE_STAFF: "Venue staff",
  VENUE_ADMIN: "Venue admin",
  PLATFORM_ADMIN: "Platform admin",
};
