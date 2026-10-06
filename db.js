// Data adapter: gives the app a small document-database API (doc, collection, where, limit,
// onSnapshot, add, set, update, delete) on top of one Supabase table, public.docs.
(function () {
  function key(path) { return path.replace(/\//g, "~"); }
  function rid() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function snapOf(row) { return { id: row.id, exists: true, data: function () { return row.data; } }; }
  function missing(id) { return { id: id, exists: false, data: function () { return undefined; } }; }
  function err(e) { return { code: (e && e.code) || "unavailable", message: (e && e.message) || "error" }; }

  window.makeDb = function (sb, uid) {
    var listeners = [];
    function pingAll() { listeners.forEach(function (f) { f(); }); }
    function chk(r) { if (r && r.error) throw err(r.error); pingAll(); }

    // Calls cb now, again on realtime changes in this collection, after any local write, and every 30 s.
    function listen(col, cb, onlyId) {
      var t = null;
      function fire() { clearTimeout(t); t = setTimeout(cb, 120); }
      listeners.push(fire);
      var ch = sb.channel("c" + rid())
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + col }, function (p) {
          var rowId = (p.new && p.new.id) || (p.old && p.old.id);
          if (onlyId && rowId && rowId !== onlyId) return;
          fire();
        }).subscribe();
      var poll = setInterval(cb, 30000);
      cb();
      return function () {
        clearTimeout(t); clearInterval(poll);
        listeners = listeners.filter(function (f) { return f !== fire; });
        sb.removeChannel(ch);
      };
    }

    function dref(path) {
      var parts = path.split("/"), id = parts.pop(), col = key(parts.join("/"));
      function fetchOne() {
        return sb.from("docs").select("id,data").eq("collection", col).eq("id", id).maybeSingle()
          .then(function (r) { if (r.error) throw err(r.error); return r.data ? snapOf(r.data) : missing(id); });
      }
      var ref = {
        id: id, path: path, get: fetchOne,
        set: function (d) {
          return sb.from("docs").upsert({ collection: col, id: id, data: d, updated_at: new Date().toISOString() }).then(chk);
        },
        update: function (d) {
          return fetchOne().then(function (s) {
            if (!s.exists) throw { code: "invalid_argument", message: "Document does not exist" };
            return ref.set(Object.assign({}, s.data(), d));
          });
        },
        delete: function () { return sb.from("docs").delete().eq("collection", col).eq("id", id).then(chk); },
        onSnapshot: function (next, error) {
          return listen(col, function () { fetchOne().then(next, error || function () {}); }, id);
        },
        collection: function (c) { return cref(path + "/" + c); }
      };
      return ref;
    }

    function cref(path, filters, lim) {
      filters = filters || [];
      var col = key(path);
      var q = {
        where: function (f, op, v) { return cref(path, filters.concat([[f, v]]), lim); },
        orderBy: function () { return q; },
        limit: function (n) { return cref(path, filters, n); },
        get: function () {
          var b = sb.from("docs").select("id,data").eq("collection", col);
          filters.forEach(function (f) { b = b.eq("data->>" + f[0], String(f[1])); });
          if (lim) b = b.limit(lim);
          return b.then(function (r) {
            if (r.error) throw err(r.error);
            var docs = r.data.map(snapOf);
            return { docs: docs, size: docs.length, empty: !docs.length };
          });
        },
        onSnapshot: function (next, error) {
          return listen(col, function () { q.get().then(next, error || function () {}); });
        },
        doc: function (id) { return dref(path + "/" + (id || rid())); },
        add: function (d) { var r = q.doc(); return r.set(d).then(function () { return r; }); }
      };
      return q;
    }

    return { collection: function (c) { return cref(c); }, doc: dref };
  };
})();
