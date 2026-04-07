PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_TicketLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalRef" TEXT,
    "prState" TEXT,
    "prNumber" INTEGER,
    "prUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketLink_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_TicketLink" ("createdAt", "externalRef", "id", "prNumber", "prState", "prUpdatedAt", "provider", "ticketId", "url")
SELECT "createdAt", "externalRef", "id", "prNumber", "prState", "prUpdatedAt", "provider", "ticketId", "url"
FROM "TicketLink";

DROP TABLE "TicketLink";
ALTER TABLE "new_TicketLink" RENAME TO "TicketLink";
CREATE UNIQUE INDEX "TicketLink_ticketId_url_key" ON "TicketLink"("ticketId", "url");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
