import { Chat } from "@/components/chat";
import { userOptions } from "@/lib/user-options";

export default function Page() {
  return <Chat users={userOptions()} />;
}
