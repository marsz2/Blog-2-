// Sumanvi Blog frontend. Data and authentication are handled by /api on server.js.
let editingBlogId = null;

document.addEventListener("DOMContentLoaded", () => {
  loadBlogs();
  loadSingleBlog();
  checkAdminSession();
  const loginForm = document.getElementById("loginForm");
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
  const saveBtn = document.getElementById("saveBlogBtn");
  if (saveBtn) saveBtn.addEventListener("click", saveBlog);
  const cancelBtn = document.getElementById("cancelEditBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", resetBlogForm);
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : {"Content-Type":"application/json"}), ...(options.headers || {}) }
  });
  const result = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
  return result;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
async function loadBlogs() {
  const list = document.getElementById("blogList");
  if (!list) return;
  try {
    const blogs = await api("/api/blogs");
    if (!blogs.length) { list.innerHTML = "<p>No blogs published yet.</p>"; return; }
    list.innerHTML = blogs.map(blog => `
      <article class="blog-card">
        ${blog.image_url ? `<img src="${escapeHtml(blog.image_url)}" alt="${escapeHtml(blog.title)}">` : ""}
        <div class="blog-card-content">
          <h2>${escapeHtml(blog.title)}</h2>
          <p>${escapeHtml(blog.excerpt || "")}</p>
          <a class="read-more" href="blog.html?slug=${encodeURIComponent(blog.slug)}">Read More →</a>
        </div>
      </article>`).join("");
  } catch (e) { list.innerHTML = "<p>Unable to load blogs.</p>"; console.error(e); }
}
async function loadSingleBlog() {
  const container = document.getElementById("singleBlog");
  if (!container) return;
  const slug = new URLSearchParams(location.search).get("slug");
  if (!slug) { container.innerHTML = "<h1>Blog not found.</h1>"; return; }
  try {
    const blog = await api(`/api/blogs/${encodeURIComponent(slug)}`);
    document.title = `${blog.title} | Sumanvi`;
    container.innerHTML = `<h1>${escapeHtml(blog.title)}</h1>
      ${blog.image_url ? `<img src="${escapeHtml(blog.image_url)}" alt="${escapeHtml(blog.title)}">` : ""}
      <div class="blog-content">${escapeHtml(blog.content)}</div>`;
  } catch { container.innerHTML = "<h1>Blog not found.</h1>"; }
}
async function handleLogin(event) {
  event.preventDefault();
  const message = document.getElementById("loginMessage");
  message.textContent = "Logging in...";
  try {
    await api("/api/login", {method:"POST", body:JSON.stringify({
      email:document.getElementById("email").value.trim(),
      password:document.getElementById("password").value
    })});
    message.textContent = "Login successful.";
    showDashboard();
  } catch(e) { message.textContent = e.message; }
}
async function checkAdminSession() {
  try { const result = await api("/api/session"); if (result.authenticated) showDashboard(); }
  catch(e) { console.error(e); }
}
function showDashboard() {
  const loginBox = document.querySelector(".admin-box");
  const dashboard = document.getElementById("dashboard");
  if (loginBox) loginBox.style.display = "none";
  if (dashboard) { dashboard.style.display = "block"; loadAdminBlogs(); }
}
async function logout() {
  try { await api("/api/logout", {method:"POST", body:"{}"}); location.reload(); }
  catch(e) { alert(e.message); }
}
async function saveBlog() {
  const title = document.getElementById("blogTitle").value.trim();
  const slug = document.getElementById("blogSlug").value.trim();
  const excerpt = document.getElementById("blogExcerpt").value.trim();
  const content = document.getElementById("blogContent").value.trim();
  const published = document.getElementById("blogPublished").checked;
  const imageInput = document.getElementById("blogImage");
  const message = document.getElementById("adminMessage");
  if (!title || !slug || !content) { message.textContent = "Title, slug and content are required."; return; }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { message.textContent = "Slug must use lowercase letters, numbers and hyphens only."; return; }
  message.textContent = "Saving...";
  try {
    let imageUrl = null;
    if (editingBlogId) {
      const old = await api(`/api/admin/blogs/${editingBlogId}`);
      imageUrl = old.image_url || null;
    }
    if (imageInput.files?.length) {
      const form = new FormData();
      form.append("image", imageInput.files[0]);
      const upload = await api("/api/admin/upload", {method:"POST", body:form});
      imageUrl = upload.image_url;
    }
    const payload = {title, slug, excerpt, content, published, image_url:imageUrl};
    if (editingBlogId) await api(`/api/admin/blogs/${editingBlogId}`, {method:"PUT", body:JSON.stringify(payload)});
    else await api("/api/admin/blogs", {method:"POST", body:JSON.stringify(payload)});
    message.textContent = editingBlogId ? "Blog updated successfully." : "Blog added successfully.";
    resetBlogForm(); await loadAdminBlogs(); await loadBlogs();
  } catch(e) { message.textContent = e.message; }
}
async function loadAdminBlogs() {
  const container = document.getElementById("adminBlogList");
  if (!container) return;
  try {
    const blogs = await api("/api/admin/blogs");
    if (!blogs.length) { container.innerHTML = "<p>No blogs yet.</p>"; return; }
    container.innerHTML = blogs.map(blog => `<div class="admin-blog">
      <h3>${escapeHtml(blog.title)}</h3><p>Slug: ${escapeHtml(blog.slug)}</p>
      <p class="publish-status">Status: ${blog.published ? "Published" : "Draft"}</p>
      <div class="admin-blog-actions">
      <button class="edit-btn" data-edit="${blog.id}">Edit</button>
      <button class="delete-btn" data-delete="${blog.id}">Delete</button></div></div>`).join("");
    container.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => editBlog(b.dataset.edit)));
    container.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", () => deleteBlog(b.dataset.delete)));
  } catch(e) { container.innerHTML = `<p>${escapeHtml(e.message)}</p>`; }
}
async function editBlog(id) {
  try {
    const blog = await api(`/api/admin/blogs/${id}`);
    editingBlogId = id;
    document.getElementById("blogTitle").value = blog.title;
    document.getElementById("blogSlug").value = blog.slug;
    document.getElementById("blogExcerpt").value = blog.excerpt || "";
    document.getElementById("blogContent").value = blog.content;
    document.getElementById("blogPublished").checked = blog.published;
    document.getElementById("formTitle").textContent = "Edit Blog";
    document.getElementById("saveBlogBtn").textContent = "Update Blog";
    document.getElementById("cancelEditBtn").style.display = "inline-block";
    window.scrollTo({top:document.querySelector(".blog-form").offsetTop, behavior:"smooth"});
  } catch(e) { alert(e.message); }
}
async function deleteBlog(id) {
  if (!confirm("Are you sure you want to delete this blog?")) return;
  try { await api(`/api/admin/blogs/${id}`, {method:"DELETE"}); alert("Blog deleted successfully."); await loadAdminBlogs(); await loadBlogs(); }
  catch(e) { alert(e.message); }
}
function resetBlogForm() {
  editingBlogId = null;
  ["blogTitle","blogSlug","blogExcerpt","blogContent","blogImage"].forEach(id => { const el=document.getElementById(id); if(el) el.value=""; });
  document.getElementById("blogPublished").checked = false;
  document.getElementById("formTitle").textContent = "Add New Blog";
  document.getElementById("saveBlogBtn").textContent = "Save Blog";
  document.getElementById("cancelEditBtn").style.display = "none";
}
