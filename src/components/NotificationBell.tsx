import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/pension";
import { useNavigate } from "react-router";

/** In-app notification inbox for the signed-in user's workspace. */
export function NotificationBell({ onDark = false }: { onDark?: boolean }) {
  const rows = useQuery(api.notifications.listMine) ?? [];
  const markRead = useMutation(api.notifications.markRead);
  const navigate = useNavigate();
  const unread = rows.filter((r) => !r.readAt);

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open && unread.length > 0) void markRead({ ids: unread.map((r) => r._id) });
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ""}`}
          className={`relative rounded-lg p-2 ${onDark ? "text-white/80 hover:bg-white/10" : "text-[#0B1F2A] hover:bg-[#F0F4F4]"}`}
        >
          <Bell className="size-5" />
          {unread.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-[#C4453C] px-1 text-[10px] font-bold text-white">
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-bold">Notifications</p>
          {unread.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void markRead({ ids: unread.map((r) => r._id) })}
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">You're all caught up.</p>
          ) : (
            rows.map((n) => (
              <button
                key={n._id}
                type="button"
                className="block w-full border-b px-4 py-3 text-left last:border-0 hover:bg-[#F7F9F8]"
                onClick={() => n.link && navigate(n.link)}
              >
                <p className={`text-sm ${n.readAt ? "font-medium" : "font-bold"}`}>
                  {!n.readAt && <span className="mr-1.5 inline-block size-2 rounded-full bg-[#007A4D]" />}
                  {n.title}
                </p>
                <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{n.body}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{fmtDateTime(n.createdAt)}</p>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
