"use client";

import { PageHeader } from "@/components/atoms";
import { BookingsTable } from "@/components/booking/bookings-table";

export default function ConsoleBookingsPage() {
  return (
    <>
      <PageHeader
        title="Bookings"
        description="Every booking at your venue. Staff can cancel on a customer's behalf."
      />
      <BookingsTable showCustomer />
    </>
  );
}
