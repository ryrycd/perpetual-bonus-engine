// src/rotator.js
export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.cache = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/assign") {
      const link = await this.assignLink();
      return new Response(JSON.stringify(link), { status: 200, headers: { "Content-Type": "application/json" }});
    }
    if (request.method === "POST" && url.pathname === "/increment") {
      const { linkId } = await request.json();
      const out = await this.incrementAndRotate(linkId);
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" }});
    }
    if (request.method === "GET" && url.pathname === "/status") {
      await this.refresh();
      return new Response(JSON.stringify(this.cache), { status: 200, headers: { "Content-Type": "application/json" }});
    }
    return new Response("Not found", { status: 404 });
  }

  async refresh(force=false) {
    if (this.cache && !force) return;
    const rows = await this.env.DB.prepare(
      "SELECT id, url, threshold, verified_count, position FROM links ORDER BY position ASC"
    ).all();
    const list = rows.results;
    let activeId = null;
    for (const r of list) {
      if (r.verified_count < r.threshold) { activeId = r.id; break; }
    }
    this.cache = { activeId, list };
  }

  async assignLink() {
    await this.refresh(true);
    if (!this.cache.activeId) {
      const last = this.cache.list[this.cache.list.length - 1];
      return { id: last?.id, url: last?.url };
    }
    const link = this.cache.list.find(l => l.id === this.cache.activeId);
    return { id: link.id, url: link.url };
  }

  async incrementAndRotate(linkId) {
    await this.env.DB.exec("BEGIN IMMEDIATE;");
    const row = await this.env.DB.prepare(
      "SELECT verified_count, threshold FROM links WHERE id=?"
    ).bind(linkId).first();
    if (!row) { await this.env.DB.exec("ROLLBACK;"); return { ok:false, reason:"link not found" }; }
    const newCount = row.verified_count + 1;
    await this.env.DB.prepare(
      "UPDATE links SET verified_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(newCount, linkId).run();
    await this.env.DB.exec("COMMIT;");

    await this.refresh(true);
    await this.env.DB.exec("UPDATE links SET active=0;");
    if (this.cache.activeId) {
      await this.env.DB.prepare("UPDATE links SET active=1 WHERE id=?")
        .bind(this.cache.activeId).run();
    }
    return { ok:true, newCount, activeId: this.cache.activeId };
  }
}
