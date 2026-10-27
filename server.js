require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
for (const key of REQUIRED) if (!process.env[key]) {
  console.error(`Missing required environment variable: ${key}`); process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12) {
  console.error("ADMIN_PASSWORD must be at least 12 characters."); process.exit(1);
}
const adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, {recursive:true});
app.use(express.json({limit:"1mb"}));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname,"public")));
const COOKIE = "sumanvi_admin";
function signToken() {
  return jwt.sign({sub:process.env.ADMIN_EMAIL.toLowerCase()}, process.env.JWT_SECRET, {expiresIn:"8h"});
}
function requireAdmin(req,res,next) {
  const token = req.cookiesToken || (req.headers.cookie || "").split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);
  try {
    const payload = jwt.verify(decodeURIComponent(token || ""), process.env.JWT_SECRET);
    if (payload.sub !== process.env.ADMIN_EMAIL.toLowerCase()) throw new Error("Invalid admin");
    req.isAdmin = true; next();
  } catch { return res.status(401).json({error:"Please log in as admin."}); }
}
function setAuthCookie(res) {
  res.cookie(COOKIE, signToken(), {httpOnly:true, secure:process.env.NODE_ENV==="production", sameSite:"strict", maxAge:8*60*60*1000, path:"/"});
}
function cleanBlog(row) { return row ? {...row, id:String(row.id)} : row; }
function validateBlog(b) {
  if (!b || typeof b.title!=="string" || !b.title.trim() || typeof b.slug!=="string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.slug) || typeof b.content!=="string" || !b.content.trim())
    return "Title, valid slug, and content are required. Slug must use lowercase letters, numbers and hyphens.";
  if (b.title.length>250 || b.slug.length>200 || String(b.excerpt||"").length>1000 || b.content.length>100000)
    return "One or more fields exceed the allowed length.";
  return null;
}
app.get("/api/health", async (req,res) => {
  try { await pool.query("SELECT 1"); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});
app.post("/api/login", async (req,res) => {
  const email=String(req.body?.email||"").trim().toLowerCase();
  const password=String(req.body?.password||"");
  const ok=email===process.env.ADMIN_EMAIL.toLowerCase() &&
    await bcrypt.compare(password, adminPasswordHash);
  if (!ok) return res.status(401).json({error:"Incorrect email or password."});
  setAuthCookie(res); res.json({ok:true});
});
app.post("/api/logout", (req,res) => { res.clearCookie(COOKIE,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",path:"/"}); res.json({ok:true}); });
app.get("/api/session", (req,res) => {
  const raw=(req.headers.cookie||"").split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);
  try { const p=jwt.verify(decodeURIComponent(raw||""),process.env.JWT_SECRET); return res.json({authenticated:p.sub===process.env.ADMIN_EMAIL.toLowerCase()}); }
  catch { return res.json({authenticated:false}); }
});
app.get("/api/blogs", async (req,res) => {
  try { const {rows}=await pool.query("SELECT id,title,slug,excerpt,image_url,published,created_at FROM blogs WHERE published=TRUE ORDER BY created_at DESC"); res.json(rows.map(cleanBlog)); }
  catch(e) { console.error(e); res.status(500).json({error:"Unable to load blogs."}); }
});
app.get("/api/blogs/:slug", async (req,res) => {
  try { const {rows}=await pool.query("SELECT id,title,slug,excerpt,content,image_url,published,created_at FROM blogs WHERE slug=$1 AND published=TRUE",[req.params.slug]); if(!rows[0]) return res.status(404).json({error:"Blog not found."}); res.json(cleanBlog(rows[0])); }
  catch(e) { console.error(e); res.status(500).json({error:"Unable to load blog."}); }
});
app.get("/api/admin/blogs", requireAdmin, async (req,res) => {
  try { const {rows}=await pool.query("SELECT * FROM blogs ORDER BY created_at DESC"); res.json(rows.map(cleanBlog)); }
  catch(e) { console.error(e); res.status(500).json({error:"Unable to load blogs."}); }
});
app.get("/api/admin/blogs/:id", requireAdmin, async (req,res) => {
  try { const {rows}=await pool.query("SELECT * FROM blogs WHERE id=$1",[req.params.id]); if(!rows[0]) return res.status(404).json({error:"Blog not found."}); res.json(cleanBlog(rows[0])); }
  catch(e) { console.error(e); res.status(500).json({error:"Unable to load blog."}); }
});
app.post("/api/admin/blogs", requireAdmin, async (req,res) => {
  const b=req.body, error=validateBlog(b); if(error) return res.status(400).json({error});
  try {
    const {rows}=await pool.query("INSERT INTO blogs(title,slug,excerpt,content,image_url,published) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [b.title.trim(),b.slug.trim(),String(b.excerpt||"").trim(),b.content.trim(),b.image_url||null,Boolean(b.published)]);
    res.status(201).json(cleanBlog(rows[0]));
  } catch(e) { if(e.code==="23505") return res.status(409).json({error:"That slug already exists. Please choose another."}); console.error(e); res.status(500).json({error:"Unable to save blog."}); }
});
app.put("/api/admin/blogs/:id", requireAdmin, async (req,res) => {
  const b=req.body, error=validateBlog(b); if(error) return res.status(400).json({error});
  try {
    const {rows}=await pool.query("UPDATE blogs SET title=$1,slug=$2,excerpt=$3,content=$4,image_url=$5,published=$6,updated_at=NOW() WHERE id=$7 RETURNING *",
      [b.title.trim(),b.slug.trim(),String(b.excerpt||"").trim(),b.content.trim(),b.image_url||null,Boolean(b.published),req.params.id]);
    if(!rows[0]) return res.status(404).json({error:"Blog not found."}); res.json(cleanBlog(rows[0]));
  } catch(e) { if(e.code==="23505") return res.status(409).json({error:"That slug already exists. Please choose another."}); console.error(e); res.status(500).json({error:"Unable to update blog."}); }
});
app.delete("/api/admin/blogs/:id", requireAdmin, async (req,res) => {
  try { const result=await pool.query("DELETE FROM blogs WHERE id=$1",[req.params.id]); if(!result.rowCount) return res.status(404).json({error:"Blog not found."}); res.status(204).end(); }
  catch(e) { console.error(e); res.status(500).json({error:"Unable to delete blog."}); }
});
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,uploadsDir),filename:(req,file,cb)=>{
  const ext=({".jpg":".jpg",".jpeg":".jpg",".png":".png",".webp":".webp",".gif":".gif"})[path.extname(file.originalname).toLowerCase()];
  cb(ext?null:new Error("Only JPG, PNG, WEBP and GIF images are allowed."),ext?`${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`:"");
}});
const upload=multer({storage,limits:{fileSize:5*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
app.post("/api/admin/upload", requireAdmin, (req,res) => {
  upload.single("image")(req,res,err=>{
    if(err) return res.status(400).json({error:err.message});
    if(!req.file) return res.status(400).json({error:"Choose a JPG, PNG, WEBP or GIF image under 5 MB."});
    res.status(201).json({image_url:`/uploads/${req.file.filename}`});
  });
});
app.use((err,req,res,next)=>{ console.error(err); res.status(500).json({error:"Unexpected server error."}); });
app.listen(PORT,"0.0.0.0",()=>console.log(`Sumanvi blog server listening on ${PORT}`));
