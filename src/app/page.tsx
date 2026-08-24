import { Chat } from "@/components/chat";
import { userOptions } from "@/lib/user-options";

export default function Page() {
  return (
    <main className="flex-1 flex flex-col h-screen">
      <Chat users={userOptions()} />
    </main>
  );
}
