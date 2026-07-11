// Security review finding M7: a rejected promise in an async Express handler is otherwise an
// unhandled rejection that crashes the whole process (Node 15+) rather than just failing the one
// request. Previously defined locally in dashboard.js (and only applied to 2 of its 3 routes) —
// extracted here so every router in server/routes/ can share the one implementation.
export function asyncRoute(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Internal error.' });
    });
  };
}
