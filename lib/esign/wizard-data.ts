import "server-only";
import { db } from "@/lib/database/prisma";
import { getActiveEmailAccount } from "@/lib/services/providers";
import { senderIdentity } from "./requests";
import { smsAvailable } from "./sms";

/** Everything the request wizard needs besides the draft itself. */
export async function wizardContext(userId: string) {
  const [documents, sender, account] = await Promise.all([
    db().document.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, title: true, versions: { orderBy: { version: "desc" }, select: { id: true, version: true, pageCount: true } } },
    }),
    senderIdentity(userId),
    getActiveEmailAccount(userId),
  ]);
  return { documents, sender, emailAccount: account?.email ?? null, smsAvailable: smsAvailable() };
}
