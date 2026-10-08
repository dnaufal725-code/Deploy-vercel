const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 10000;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

function vercelHeaders() {
  return {
    Authorization: `Bearer ${VERCEL_TOKEN}`,
    "Content-Type": "application/json"
  };
}

function teamQuery() {
  return VERCEL_TEAM_ID
    ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`
    : "";
}

function normalizeProjectName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/---+/g, "--")
    .slice(0, 100);
}

function validProjectName(name) {
  return (
    /^[a-z0-9._-]+$/.test(name) &&
    !name.includes("---") &&
    name.length >= 1 &&
    name.length <= 100
  );
}

function sha1(buffer) {
  return crypto
    .createHash("sha1")
    .update(buffer)
    .digest("hex");
}

function safePath(filePath) {
  const normalized = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/^(\.\.(\/|\\|$))+/, "");

  return normalized.replace(/^\/+/, "");
}

function getZipFiles(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const fileName = safePath(entry.entryName);

    if (!fileName) continue;

    if (
      fileName.startsWith(".git/") ||
      fileName.startsWith(".vercel/")
    ) {
      continue;
    }

    const data = entry.getData();

    files.push({
      name: fileName,
      data
    });
  }

  return files;
}

function getSingleHtml(buffer) {
  return [
    {
      name: "index.html",
      data: buffer
    }
  ];
}

function getCodeHtml(code) {
  return [
    {
      name: "index.html",
      data: Buffer.from(code, "utf8")
    }
  ];
}

async function vercelRequest(endpoint, options = {}) {
  const response = await fetch(
    `https://api.vercel.com${endpoint}`,
    {
      ...options,
      headers: {
        ...vercelHeaders(),
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      data?.message ||
      `Vercel API error ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

async function checkProject(name) {
  const endpoint =
    `/v9/projects/${encodeURIComponent(name)}` +
    teamQuery();

  try {
    const project = await vercelRequest(endpoint);

    return {
      available: false,
      exists: true,
      project
    };
  } catch (error) {
    if (error.status === 404) {
      return {
        available: true,
        exists: false
      };
    }

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    vercelConfigured: Boolean(VERCEL_TOKEN),
    service: "DEPLOYX"
  });
});

/*
|--------------------------------------------------------------------------
| Check Project Name
|--------------------------------------------------------------------------
*/

app.get("/api/check-project", async (req, res) => {
  try {
    if (!VERCEL_TOKEN) {
      return res.status(500).json({
        ok: false,
        message: "VERCEL_TOKEN belum dipasang di Render."
      });
    }

    const name = normalizeProjectName(req.query.name);

    if (!validProjectName(name)) {
      return res.status(400).json({
        ok: false,
        available: false,
        message:
          "Nama hanya boleh berisi huruf kecil, angka, titik, underscore, dan tanda minus."
      });
    }

    const result = await checkProject(name);

    res.json({
      ok: true,
      name,
      ...result,
      domain: `${name}.vercel.app`
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| Project Analysis
|--------------------------------------------------------------------------
*/

app.post(
  "/api/analyze",
  upload.single("file"),
  async (req, res) => {
    try {
      const source = req.body.source;

      let files = [];

      if (source === "code") {
        if (!req.body.code) {
          return res.status(400).json({
            ok: false,
            message: "HTML code kosong."
          });
        }

        files = getCodeHtml(req.body.code);
      } else {
        if (!req.file) {
          return res.status(400).json({
            ok: false,
            message: "File belum dikirim."
          });
        }

        if (source === "html") {
          files = getSingleHtml(req.file.buffer);
        }

        if (source === "zip") {
          files = getZipFiles(req.file.buffer);
        }
      }

      const index = files.find(
        f =>
          f.name.toLowerCase() === "index.html" ||
          f.name.toLowerCase().endsWith("/index.html")
      );

      const totalBytes = files.reduce(
        (sum, file) => sum + file.data.length,
        0
      );

      res.json({
        ok: true,
        files: files.length,
        totalBytes,
        hasIndex: Boolean(index),
        entry: index ? index.name : null,
        names: files.slice(0, 100).map(f => f.name)
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        ok: false,
        message: "Project tidak bisa dibaca.",
        detail: error.message
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Deploy
|--------------------------------------------------------------------------
*/

app.post(
  "/api/deploy",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!VERCEL_TOKEN) {
        return res.status(500).json({
          ok: false,
          message: "VERCEL_TOKEN belum dipasang."
        });
      }

      const name = normalizeProjectName(req.body.name);
      const source = req.body.source;

      if (!validProjectName(name)) {
        return res.status(400).json({
          ok: false,
          message: "Nama project Vercel tidak valid."
        });
      }

      /*
       * Collect files
       */

      let files = [];

      if (source === "code") {
        if (!req.body.code) {
          return res.status(400).json({
            ok: false,
            message: "HTML code kosong."
          });
        }

        files = getCodeHtml(req.body.code);
      }

      if (source === "html") {
        if (!req.file) {
          return res.status(400).json({
            ok: false,
            message: "HTML belum dipilih."
          });
        }

        files = getSingleHtml(req.file.buffer);
      }

      if (source === "zip") {
        if (!req.file) {
          return res.status(400).json({
            ok: false,
            message: "ZIP belum dipilih."
          });
        }

        files = getZipFiles(req.file.buffer);
      }

      if (!files.length) {
        return res.status(400).json({
          ok: false,
          message: "Tidak ada file untuk dideploy."
        });
      }

      /*
       * Ensure project exists
       */

      let project;

      try {
        project = await vercelRequest(
          `/v9/projects/${encodeURIComponent(name)}` +
            teamQuery(),
          {
            method: "GET"
          }
        );
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }

        project = await vercelRequest(
          `/v11/projects${teamQuery()}`,
          {
            method: "POST",
            body: JSON.stringify({
              name
            })
          }
        );
      }

      /*
       * Upload every file using SHA
       */

      const deploymentFiles = [];

      for (const file of files) {
        const digest = sha1(file.data);

        try {
          await vercelRequest("/v2/files", {
            method: "POST",
            headers: {
              "x-vercel-digest": digest,
              "Content-Type": "application/octet-stream"
            },
            body: file.data
          });
        } catch (error) {
          /*
           * If Vercel already has this SHA, it can be reused.
           */
          if (
            error.status !== 409 &&
            error.status !== 400
          ) {
            throw error;
          }
        }

        deploymentFiles.push({
          file: file.name,
          sha: digest,
          size: file.data.length
        });
      }

      /*
       * Create production deployment
       */

      const deployment = await vercelRequest(
        `/v13/deployments${teamQuery()}`,
        {
          method: "POST",
          body: JSON.stringify({
            name,
            project: project.id || project.name,
            files: deploymentFiles,
            target: "production",
            projectSettings: {
              framework: null
            }
          })
        }
      );

      res.json({
        ok: true,
        projectId: project.id || null,
        deploymentId: deployment.id,
        name,
        url: deployment.url
          ? `https://${deployment.url}`
          : null,
        inspectorUrl: deployment.inspectorUrl || null,
        state: deployment.readyState || "QUEUED",
        files: files.length
      });
    } catch (error) {
      console.error("DEPLOY ERROR:", error);

      res.status(error.status || 500).json({
        ok: false,
        message:
          error.message ||
          "Deployment gagal.",
        detail: error.data || null
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Deployment Status
|--------------------------------------------------------------------------
*/

app.get("/api/deployment/:id", async (req, res) => {
  try {
    if (!VERCEL_TOKEN) {
      return res.status(500).json({
        ok: false,
        message: "VERCEL_TOKEN belum dipasang."
      });
    }

    const deployment = await vercelRequest(
      `/v13/deployments/${encodeURIComponent(
        req.params.id
      )}${VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : ""}`,
      {
        method: "GET"
      }
    );

    res.json({
      ok: true,
      id: deployment.id,
      state: deployment.readyState,
      url: deployment.url
        ? `https://${deployment.url}`
        : null,
      inspectorUrl: deployment.inspectorUrl || null
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      message: error.message
    });
  }
});

/*
|--------------------------------------------------------------------------
| Fallback
|--------------------------------------------------------------------------
*/

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DEPLOYX running on port ${PORT}`
  );
});
