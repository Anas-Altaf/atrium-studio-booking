"use client";

import { PageHeader } from "@/components/atoms";
import { BookingsTable } from "@/components/booking/bookings-table";

export default function BookingsPage() {
  return (
    <>
      <PageHeader
        title="My bookings"
        description="Everything you have held, paid for or cancelled."
      />
      <BookingsTable />
    </>
  );
}
