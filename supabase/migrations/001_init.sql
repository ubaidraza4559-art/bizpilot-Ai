-- BizPilot AI — PostgreSQL migration for the Supabase production target.
-- Run in the Supabase SQL Editor. Enables RLS on every user-owned table.
-- NOTE: the local runnable build uses the equivalent SQLite schema in server.js.
create extension if not exists pgcrypto;
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null, email text not null unique,
  business_name text not null default '', business_type text not null default '',
  preferred_language text not null default 'English',
  plan text not null default 'FREE' check (plan in ('FREE','STARTER','PRO','AGENCY')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists leads (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  client_name text not null, email text not null default '', phone text not null default '',
  company text not null default '', service text not null default '', source text not null default 'Other',
  budget numeric not null default 0 check (budget >= 0), currency text not null default 'USD',
  status text not null default 'New' check (status in ('New','Contacted','Qualified','Proposal Sent','Negotiation','Won','Lost')),
  priority text not null default 'Medium' check (priority in ('Low','Medium','High')),
  notes text not null default '', next_follow_up date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  title text not null, notes text not null default '', due_date date not null,
  status text not null default 'Pending' check (status in ('Pending','Completed')),
  completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  client_name text not null, client_company text not null default '', title text not null,
  overview text not null default '', scope text not null default '', deliverables jsonb not null default '[]',
  timeline text not null default '', currency text not null default 'USD',
  tax_rate numeric not null default 0, discount numeric not null default 0,
  payment_terms text not null default '', notes text not null default '',
  status text not null default 'Draft' check (status in ('Draft','Sent','Accepted','Rejected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  title text not null, category text not null default 'General', body text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists ai_generation_history (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  output_type text not null, tone text not null default 'Professional', language text not null default 'English',
  input_text text not null default '', output_text text not null, provider text not null default 'template',
  created_at timestamptz not null default now()
);
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  month text not null, count int not null default 0, unique (user_id, month)
);
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references profiles(id) on delete cascade,
  plan text not null, status text not null default 'active', stripe_subscription_id text,
  current_period_end timestamptz, created_at timestamptz not null default now()
);
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references profiles(id) on delete cascade,
  name text not null, created_at timestamptz not null default now()
);
create table if not exists workspace_members (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade, role text not null default 'member',
  unique (workspace_id, user_id)
);
create index if not exists idx_leads_user_search on leads(user_id, client_name, company, email, service);
create index if not exists idx_leads_status on leads(user_id, status);
create index if not exists idx_followups_due on follow_ups(user_id, due_date, status);
create index if not exists idx_proposals_user on proposals(user_id);
create index if not exists idx_ai_history_user on ai_generation_history(user_id, created_at);
alter table profiles enable row level security;
alter table leads enable row level security;
alter table follow_ups enable row level security;
alter table proposals enable row level security;
alter table message_templates enable row level security;
alter table ai_generation_history enable row level security;
alter table ai_usage enable row level security;
alter table subscriptions enable row level security;
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
-- Owner-only policies: auth.uid() is the proof, never a client-supplied user id.
create policy "own profile" on profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own leads" on leads for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own follow_ups" on follow_ups for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own proposals" on proposals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own templates" on message_templates for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own ai_history" on ai_generation_history for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own ai_usage" on ai_usage for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own subscriptions" on subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own workspaces" on workspaces for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "own memberships" on workspace_members for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
