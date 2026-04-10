module.exports = {
  apps: [
    {
      name: "browser-agent",
      script: "agent-server.js",
      autorestart: true,
      max_memory_restart: "100M",
      env: {
        NODE_ENV: "production",
        BROWSER_AGENT_PORT: 3102,
      },
    },
  ],
};
