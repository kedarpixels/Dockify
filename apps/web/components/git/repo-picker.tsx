"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { ResultCount } from "@/components/ui/result-count";
import { Skel } from "@/components/ui/skeleton";
import { useNow } from "@/lib/hooks";
import type { GitInstallation, GitRepo, GitRepoPage } from "@/lib/pages/git";
import { AccountSelect } from "./account-select";
import { gitFetch, startInstall, type Installations } from "./client";
import { clause } from "@/lib/format";
import { RepoRow, RepoSkeleton } from "./repo-row";

/* Arrow keys in the search move through the rows and Enter imports; "/" jumps to the search. */

type Repos =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; items: GitRepo[]; nextCursor: string | null; more: "idle" | "loading" | "failed" };

export function RepoPicker({
  installations,
  reload,
  account,
  onAccount,
  onPick,
  onUseUrl,
  inputRef,
}: {
  installations: Installations;
  reload: () => void;
  account: string | null;
  onAccount: (id: string) => void;
  onPick: (installation: GitInstallation, repo: GitRepo) => void;
  onUseUrl: () => void;
  /** The search input, so the flow can hand focus back to it after step 2. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const now = useNow(30_000);
  const own = useRef<HTMLInputElement>(null);
  const search = inputRef ?? own;
  const list = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const more = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [settled, setSettled] = useState("");
  const [repos, setRepos] = useState<Repos>({ state: "loading" });
  const [active, setActive] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const accounts = installations.state === "ready" ? installations.list : [];
  const current = accounts.find((i) => i.id === account) ?? null;

  const searchable = accounts.length > 0;
  useEffect(() => {
    if (searchable) search.current?.focus({ preventScroll: true });
  }, [searchable, search]);

  // Typing settles for 200ms before it searches; clearing searches at once.
  const onQuery = (next: string) => {
    setQuery(next);
    if (!next.trim()) setSettled("");
  };
  useEffect(() => {
    const next = query.trim();
    if (!next) return;
    const t = setTimeout(() => setSettled(next), 200);
    return () => clearTimeout(t);
  }, [query]);
  const q = query.trim() ? settled : "";

  // A new account, search or retry starts over, from the render that asks for it.
  const page = current ? `${current.id}\n${q}\n${attempt}` : "";
  const [asked, setAsked] = useState(page);
  if (page !== asked) {
    setAsked(page);
    setRepos({ state: "loading" });
    setActive(0);
  }

  // A newer first page aborts the call still in flight.
  useEffect(() => {
    if (!current) return;
    const ctl = new AbortController();
    more.current?.abort();
    const params = new URLSearchParams({ installation: current.id });
    if (q) params.set("q", q);
    void gitFetch<GitRepoPage>(`/repos?${params}`, { signal: ctl.signal }).then((r) => {
      if (ctl.signal.aborted) return;
      setRepos(r.ok ? { state: "ready", items: r.data.items, nextCursor: r.data.nextCursor, more: "idle" } : { state: "error", error: r.error });
    });
    return () => {
      ctl.abort();
      more.current?.abort();
    };
  }, [current, q, attempt]);

  const cursor = repos.state === "ready" && repos.more === "idle" ? repos.nextCursor : null;

  // The next page's call belongs to the first page it extends, so only a new account or search aborts it.
  useEffect(() => {
    const end = sentinel.current;
    if (!cursor || !current || !end) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        const ctl = new AbortController();
        more.current = ctl;
        setRepos((s) => (s.state === "ready" ? { ...s, more: "loading" } : s));
        const params = new URLSearchParams({ installation: current.id, cursor });
        if (q) params.set("q", q);
        void gitFetch<GitRepoPage>(`/repos?${params}`, { signal: ctl.signal }).then((r) => {
          if (ctl.signal.aborted) return;
          setRepos((s) =>
            s.state !== "ready" ? s : r.ok ? { state: "ready", items: [...s.items, ...r.data.items], nextCursor: r.data.nextCursor, more: "idle" } : { ...s, more: "failed" },
          );
        });
      },
      { root: list.current },
    );
    io.observe(end);
    return () => io.disconnect();
  }, [cursor, current, q]);

  const items = repos.state === "ready" ? repos.items : [];

  // Keep the active row inside the list's own scroll, never scrolling the page.
  useEffect(() => {
    const ul = list.current;
    const row = ul?.children[active];
    if (!ul || !(row instanceof HTMLElement)) return;
    if (row.offsetTop < ul.scrollTop) ul.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = row.offsetTop + row.offsetHeight - ul.clientHeight;
  }, [active]);

  const connect = async () => {
    setInstalling(true);
    // On success the browser is leaving for GitHub, so the key stays pending.
    if (!(await startInstall())) setInstalling(false);
  };

  const urlLink = (
    <button type="button" className="git-link" onClick={onUseUrl}>
      Import from a URL instead
    </button>
  );

  if (installations.state === "loading") {
    return (
      <div className="git-pick" aria-busy="true">
        <div className="git-pick-hd" aria-hidden="true">
          <Skel h={36} r={10} className="git-skel-account" />
          <Skel h={36} r={10} className="git-skel-search" />
        </div>
        <RepoSkeleton />
      </div>
    );
  }

  if (installations.state === "error") {
    return (
      <div className="git-pick git-pick-state">
        <Empty
          icon="github"
          title="GitHub accounts are unavailable"
          body={`${clause(installations.error)}. Try again, or import a public repository by its URL.`}
          action={
            <button type="button" className="btn btn-sm" onClick={reload}>
              Try again
            </button>
          }
        />
        <p className="git-pick-foot">{urlLink}</p>
      </div>
    );
  }

  if (!accounts.length) {
    return (
      <div className="git-pick git-pick-state">
        <Empty
          icon="github"
          title="No GitHub accounts yet"
          body="Install the Dockify GitHub App on your account or organization, then pick a repository from the list."
          action={
            <PendingButton className="btn btn-primary" pending={installing} icon="github" onClick={() => void connect()}>
              Connect GitHub
            </PendingButton>
          }
        />
        <p className="git-pick-foot">{urlLink}</p>
      </div>
    );
  }

  const importAt = (i: number) => {
    const repo = items[i];
    if (repo && current) onPick(current, repo);
  };

  // Arrows and Enter bubble up from the search input; SearchField keeps Esc to itself.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== search.current) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + by + items.length) % items.length);
    } else if (e.key === "Enter") {
      // Never the surrounding form's submit: Enter here means import the active row.
      e.preventDefault();
      importAt(active);
    }
  };

  const searching = Boolean(q);
  const activeRepo = items[active];

  return (
    <div className="git-pick">
      <div className="git-pick-hd">
        <AccountSelect installations={accounts} value={current?.id ?? null} onChange={onAccount} onAdd={() => void connect()} disabled={installing} />
        <div className="git-search" onKeyDown={onKey}>
          <SearchField value={query} onChange={onQuery} inputRef={search} label="Search repositories" placeholder="Search repository names" />
        </div>
        {repos.state === "ready" ? <ResultCount count={items.length} one="repository" many="repositories" query={q} /> : null}
      </div>

      {repos.state === "loading" ? (
        <RepoSkeleton />
      ) : repos.state === "error" ? (
        <div className="git-pick-state">
          <Empty
            icon="github"
            title="Repositories are unavailable"
            body={`${clause(repos.error)}. Try again in a moment.`}
            action={
              <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            }
          />
        </div>
      ) : !items.length ? (
        <div className="git-pick-state">
          {searching ? (
            <Empty
              icon="search"
              title="No repositories match"
              body={`Nothing matches “${q}”. Only repositories the Dockify GitHub App can read on ${current?.account.login} are listed.`}
              action={
                <button type="button" className="btn btn-sm" onClick={() => onQuery("")}>
                  Clear search
                </button>
              }
            />
          ) : (
            <Empty
              icon="github"
              title="No repositories yet"
              body={`The Dockify GitHub App cannot read any repository on ${current?.account.login}. Give it access on GitHub.`}
            />
          )}
        </div>
      ) : (
        <ul ref={list} className="git-list" aria-label={`Repositories on ${current?.account.login}`}>
          {items.map((r, i) => (
            <RepoRow key={r.id} repo={r} now={now} active={i === active} onPoint={() => setActive(i)} onImport={() => importAt(i)} />
          ))}
          {repos.nextCursor || repos.more !== "idle" ? (
            <li ref={sentinel} className="git-more">
              {repos.more === "failed" ? (
                <button type="button" className="btn btn-sm" onClick={() => setRepos({ ...repos, more: "idle" })}>
                  Load more
                </button>
              ) : (
                <Icon name="loader" className="spin" label="Loading more repositories" />
              )}
            </li>
          ) : null}
        </ul>
      )}
      <span className="sr" aria-live="polite">
        {activeRepo ? `${activeRepo.fullName}, press Enter to import` : ""}
      </span>

      <p className="git-pick-foot">
        {current ? (
          <a href={current.manageUrl} target="_blank" rel="noopener noreferrer" className="git-link">
            Missing a repo? Adjust access
          </a>
        ) : null}
        {urlLink}
      </p>
    </div>
  );
}
