/**
 * Seed — one demo project with real client material to run the pipeline against.
 *
 * Idempotent: running it twice leaves one project. It creates nothing else, because everything
 * downstream of the documents is supposed to be produced by the agents rather than fixtured.
 */

import { db } from './db.js';
import { seedMcp } from './seed-mcp.js';

const DISCOVERY_CALL = `Discovery call — 12 March, 10:00–11:15
Present: Dana Okafor (COO, Northwind Services), Marc Ellis (Head of Support),
Priya Raman (Finance), and our side.

Dana: The core problem is that we run customer records in three places. Sales keeps them in a
spreadsheet, support has its own ticketing tool with a separate customer list, and finance works
from the billing system. Nobody agrees on how many customers we have. Last quarter we billed two
companies twice because they existed as separate records in billing and nobody noticed.

Marc: For support the pain is different. When a customer calls, my team has no history. They can
see the tickets, but not what the customer pays, whether they are in arrears, or whether sales
promised them something. Average handling time is about eleven minutes and I would guess three of
those are spent looking things up in other systems.

Dana: So: one customer record, and everyone works from it. That is the project.

Priya: With the caveat that finance cannot lose the billing history. We are audited annually and we
must be able to show, for any invoice, who approved it and when. If a customer record changes we
need to know what it looked like at the time we billed them.

Dana: Agreed. And I want the whole thing to be self-service for signup — a company should be able
to sign up on the website and start a trial without talking to anyone.

Marc: That worries me. We have had fraud attempts. If anyone can sign up we will get abuse, and
support ends up cleaning it up.

Dana: Then we vet them, but afterwards, not before. I do not want a sales call blocking a trial.

Priya: Whatever we do, invoices must stay immutable once issued. Corrections happen through credit
notes, never by editing the original.

Marc: Practical things from my side: my agents need to search customers by name, email, phone and
company number, and it needs to be fast — right now the ticketing search takes about eight seconds
on a bad day and they have the customer on the line.

Dana: We have roughly 12,000 customers today, growing maybe 30% a year. Nothing enormous.

Priya: Who is allowed to see what? Support should not see full payment details. My team should not
be editing customer contact records.

Dana: Right — roles. Support, finance, sales, admin.

Marc: And an audit trail on the customer record itself. If someone deactivates a customer I need to
know who did it and when. We had a case last year where an account was closed and nobody could say
who closed it.

Dana: Timeline: we would like something usable within a quarter. It does not have to do everything
on day one, but it has to replace the spreadsheet, because the spreadsheet is how we billed the
same company twice.

Priya: One more. GDPR. If a customer asks to be deleted we have to be able to do it, but we cannot
delete billing records — we are required to keep those for seven years.

Dana: Then we anonymise the person and keep the invoice. Legal can confirm the exact wording.

Marc: What about the existing ticket history? We have four years of it.

Dana: Import it. If it cannot be linked to a customer, leave it unlinked rather than guessing.

Priya: And on reporting — I need a monthly export of active customers with their contract value.
CSV is fine. It does not need to be a dashboard.

Dana: To be clear on what we are not doing: no marketing automation, no email campaigns, no mobile
app. This is a customer record with support and billing hanging off it.
`;

const CONSTRAINTS_NOTE = `Follow-up notes — 14 March (email from Dana)

A few things I forgot on the call:

- We are a Microsoft shop. Whatever this runs on, single sign-on has to work with Entra ID. Nobody
  is typing another password.
- Budget is roughly £120k for the first phase, and I would rather have less scope than more spend.
- We have two developers in-house who will maintain this afterwards. Both are comfortable with
  TypeScript and Postgres. Neither has run Kubernetes and I do not want them learning on this.
- Uptime: it needs to be up during UK business hours. Overnight maintenance is genuinely fine.
- Legal came back on GDPR: deletion requests must be actioned within 30 days, and anonymising the
  customer while retaining invoice line items is acceptable.
- Search: Marc's team considers anything under one second acceptable. Eight seconds is the thing we
  are fixing.
`;

async function main(): Promise<void> {
  const project = await db.project.upsert({
    where: { key: 'CMS' },
    create: {
      key: 'CMS',
      name: 'Customer Management SaaS',
      description:
        'One customer record shared by sales, support and finance, replacing three disconnected systems.',
    },
    update: {},
  });

  const existing = await db.document.count({ where: { projectId: project.id } });
  if (existing === 0) {
    await db.document.createMany({
      data: [
        {
          projectId: project.id,
          title: 'Discovery call — 12 March',
          kind: 'MEETING',
          content: DISCOVERY_CALL,
        },
        {
          projectId: project.id,
          title: 'Follow-up notes — 14 March',
          kind: 'EMAIL',
          content: CONSTRAINTS_NOTE,
        },
      ],
    });
  }

  // MCP servers and grants, seeded disabled — see seed-mcp.ts for why.
  await seedMcp();

  console.log(`Seeded ${project.key} — ${project.name} with 2 source documents.`);
  console.log('Set a provider and API key on the Settings page, then press Start on the project.');
  await db.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
