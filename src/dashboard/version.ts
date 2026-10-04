// Single source of truth for the dashboard UI generation label (the "v4"
// shown in the header, login page, and health JSON). Bump here on a
// frontend-rewrite generation. NOTE: the no-build frontend
// (public/v4/index.html <title> + js/components/header.js badge) cannot
// import this module — those two literals must be kept in sync manually;
// this constant covers every SERVER-rendered surface.
export const DASHBOARD_VERSION = "v4";
