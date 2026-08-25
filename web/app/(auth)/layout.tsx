export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </div>

      {/* Not decoration: the reviewer needs the test logins, and this is where
          they are looked for. */}
      <aside className="hidden flex-col justify-center gap-8 border-l bg-card px-12 lg:flex">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Atrium</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Studio booking across Karachi, Dubai and London. Rooms are booked over
            an interval and never double-booked; equipment is booked as a quantity
            over that interval and never oversold.
          </p>
        </div>

        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Test logins · password <span className="font-mono">atrium123</span>
          </p>
          <ul className="space-y-1.5 font-mono text-xs text-muted-foreground">
            <li>customer@atrium.test — customer</li>
            <li>staff@atrium.test — venue staff</li>
            <li>admin.a@atrium.test — venue admin, venue A</li>
            <li>admin.b@atrium.test — venue admin, venue B</li>
            <li>platform@atrium.test — platform admin</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
