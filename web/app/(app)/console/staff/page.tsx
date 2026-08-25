"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { explain, venues, type Role, type StaffRow } from "@/lib/api";
import { keys } from "@/lib/query-keys";
import { venueTime } from "@/lib/format";
import { useProfile } from "@/lib/auth-context";
import { ROLE_LABEL } from "@/components/nav";
import { ErrorState, ListSkeleton, PageHeader } from "@/components/atoms";
import { WithVenue } from "@/components/console/console-gate";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function StaffPage() {
  return <WithVenue>{(venueId) => <StaffTable venueId={venueId} />}</WithVenue>;
}

function StaffTable({ venueId }: { venueId: string }) {
  const me = useProfile();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = React.useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: keys.venueStaff(venueId),
    queryFn: () => venues.staff(venueId),
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: keys.venueStaff(venueId) });

  const patch = useMutation({
    mutationFn: ({
      user,
      change,
    }: {
      user: StaffRow;
      change: { role?: Role; active?: boolean };
    }) => venues.updateStaff(venueId, user.id, change),
    onSuccess: () => {
      invalidate();
      toast.success("Account updated.");
    },
    onError: (err) => toast.error(explain(err)),
  });

  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader
        title="Staff"
        description="Accounts scoped to this venue. Only an admin can change pricing or policy."
        actions={
          <Button size="sm" onClick={() => setInviting(true)}>
            <UserPlus />
            Add account
          </Button>
        }
      />

      {isPending ? (
        <ListSkeleton />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((user) => {
                const self = user.id === me.userId;
                return (
                  <TableRow key={user.id} className={user.active ? "" : "opacity-55"}>
                    <TableCell>
                      <span className="font-medium">{user.email}</span>
                      {self && (
                        <Badge variant="secondary" className="ml-2">
                          you
                        </Badge>
                      )}
                      {!user.active && (
                        <Badge variant="outline" className="ml-2">
                          deactivated
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.role}
                        disabled={patch.isPending}
                        onValueChange={(role) =>
                          patch.mutate({ user, change: { role: role as Role } })
                        }
                      >
                        <SelectTrigger className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="VENUE_STAFF">
                            {ROLE_LABEL.VENUE_STAFF}
                          </SelectItem>
                          <SelectItem value="VENUE_ADMIN">
                            {ROLE_LABEL.VENUE_ADMIN}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="tnum text-muted-foreground">
                      {venueTime(user.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={self}
                        title={self ? "You cannot deactivate your own account" : undefined}
                        onClick={() =>
                          patch.mutate({ user, change: { active: !user.active } })
                        }
                      >
                        {user.active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        A venue admin can only mint venue roles. Creating a platform admin from
        here is refused — that would turn a scoped account into an unscoped one.
      </p>

      {inviting && (
        <InviteDialog
          venueId={venueId}
          onDone={() => {
            setInviting(false);
            invalidate();
          }}
          onCancel={() => setInviting(false)}
        />
      )}
    </>
  );
}

function InviteDialog({
  venueId,
  onDone,
  onCancel,
}: {
  venueId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("VENUE_STAFF");

  const create = useMutation({
    mutationFn: () => venues.addStaff(venueId, { email, password, role }),
    onSuccess: () => {
      toast.success("Account created. Hand them the password out of band.");
      onDone();
    },
    onError: (err) => toast.error(explain(err)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a venue account</DialogTitle>
          <DialogDescription>
            The account is scoped to this venue and cannot read another one.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Initial password</Label>
            <Input
              id="password"
              type="text"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters. They change it from Settings.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="VENUE_STAFF">
                  Venue staff — manages bookings
                </SelectItem>
                <SelectItem value="VENUE_ADMIN">
                  Venue admin — also pricing, policy and staff
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
