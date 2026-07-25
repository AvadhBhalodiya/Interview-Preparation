---
title: "RBAC vs ABAC"
group: "Access & Data Protection"
order: 4
---

# RBAC vs ABAC

> RBAC hands users roles, and roles carry permissions. ABAC decides each request from attributes of the subject, resource, action, and environment - finer-grained and context-aware, but its policies are code you have to author and test.

## What it is
- **RBAC (role-based):** you define a few roles (admin/editor/viewer), attach permissions to each role, and assign roles to users. A permission check just asks whether any role the user holds carries that permission.
- **ABAC (attribute-based):** there is no fixed role at the center. A policy engine reads attributes of the subject, resource, action, and environment and returns permit or deny at request time. NIST SP 800-162 is the reference model, and XACML is the classic policy language behind it.

> [!KEY] **RBAC answers from a lookup, ABAC from a function.** A role check is a table read: which permissions does this user's role carry. An ABAC check runs a policy over live attributes on every request, so there is no list of who has access, only a rule that recomputes the answer.

The two models differ on how a decision is reached and what it costs you at scale:

| Dimension | RBAC (role-based) | ABAC (attribute-based) |
| --- | --- | --- |
| **Decides on** | a **role** assigned to the user | **attributes** of subject / resource / action / environment |
| **Granularity** | **coarse, static** - `editor` can edit docs | **fine, context-aware** - edits only in the user's own dept, in business hours |
| **Scale** | **role explosion** - a new role per dimension combination | **one policy** spans a whole dimension, no new roles |
| **Admin overhead** | **low** - assign roles, audit with one query | **high** - policies are code to author, test, and debug |
| **When to use** | small, fixed role sets where **audit speed** matters | access driven by **context, ownership, or tenancy** |

A third model, **ReBAC (relationship-based)**, answers by walking a graph - you can view a doc because you can view its parent folder - and OWASP now groups it with ABAC as the modern default over plain RBAC.

> [!TIP] A role is just one more attribute, so **RBAC is a subset of ABAC**. Most production systems run RBAC for the coarse structure and layer a few attribute checks (owner-only, same-tenant) on top rather than picking one.

## Key points
- **RBAC's whole appeal is legibility.** Permissions live in roles, a user's access is the union of their roles, and "who can delete invoices?" is a single query against the role table. It checks fast and audits cleanly, which is why most apps start here and should.
- **Check permissions, not role names.** `if user.role == "admin"` scatters policy across the codebase and breaks the day you add a second admin-like role. Ask `user.has_permission("doc:edit")` so the role-to-permission mapping lives in one place.
- **Role explosion is the failure mode.** The moment access depends on a second dimension (department, region, read-vs-write, tenant) you start minting roles like `editor-emea-readonly`, and the count multiplies with every dimension until nobody can say what a role grants.
- **ABAC trades that lookup for a rule:** permit if `policy(subject, resource, action, environment)` holds. "A manager approves expenses in their own department, under $10k" is one policy in place of a role per department.
- **The cost is reasoning.** "Who can touch this record?" has no lookup answer under ABAC. There is no list, only a function, so you would run every candidate subject through the policy. Policies also interact and drift in ways a flat role table never does.
- **ReBAC shines when sharing and hierarchy dominate** - Drive-style "shared with", nested groups. Google's Zanzibar paper is the blueprint, and OpenFGA and SpiceDB are the open-source implementations.
- **Whichever model you land on, externalize it.** Put the rules in a policy engine (OPA/Rego, AWS Cedar, OpenFGA) so authorization is centralized, versioned, and testable instead of smeared across controllers. OWASP's advice is blunt: implement the mechanism once and reuse it everywhere.

ABAC names three moving parts, and interviewers expect the vocabulary:

| Component | Role in a decision |
| --- | --- |
| **PEP** (enforcement point) | your app intercepts the request and asks for a ruling |
| **PDP** (decision point) | the engine evaluates the policy and returns permit or deny |
| **PIP** (information point) | the attribute source feeds in subject, resource, and environment values |

## Example
```python
# RBAC: does the user hold a role that grants this permission?
if user.has_permission("doc:edit"):        # check a permission, not a hardcoded role name
    allow()

# ABAC: a policy decides from attributes of subject + resource + action + environment.
# Deny by default; permit only when every condition holds.
def can_edit(user, doc, now) -> bool:
    return (
        user.department == doc.department      # subject vs resource attribute
        and "editor" in user.roles             # a role is just one more attribute
        and doc.status != "locked"             # resource state
        and 9 <= now.hour < 18                 # environment
    )
```

## Interview Q&A
- **RBAC vs ABAC?** RBAC grants through roles you assign, so it is coarse, fast, and easy to audit. ABAC evaluates attributes as a policy on every request, so it is fine-grained and dynamic but harder to write and reason about.
- **What is role explosion?** RBAC's tendency to sprout a new role for every combination of dimensions (dept x region x access level) until the role set is unmanageable. It is the signal to move that logic into attributes or relationships.
- **When would you pick ABAC or ReBAC over RBAC?** When access depends on context or ownership rather than job title: same-department, resource owner, time window, tenant isolation, "shared with me." The OWASP Authorization Cheat Sheet explicitly says to prefer ABAC/ReBAC for fine-grained, multi-tenant systems.
- **What is ReBAC?** Authorization by relationships rather than roles or attributes: you can open a file because you can open its parent folder, or because it was shared with a group you belong to. It answers from a relationship graph (Google's Zanzibar model, OpenFGA and SpiceDB in practice), which is what makes deep sharing and nesting tractable.
- **Can you combine them?** Yes. A role is one attribute, so RBAC is a subset of ABAC. The usual shape is RBAC for the broad strokes plus attribute checks for ownership and tenancy.
- **"Who can access this document?"** Under RBAC that is a lookup. Under ABAC there is no list, so you would run the policy for each candidate subject, which is exactly why systems that need that query lean toward ReBAC's relationship graph.

## Gotchas
> [!WARN] **Enforce every decision server-side, on every request.** Broken Access Control is **A01:2025**, still the #1 web risk, and OWASP found some form of it in 100% of the applications they tested. A hidden button or a disabled field is not access control - the attacker just replays the request.

> [!WARN] **Passing the role check is not the same as owning the record.** "editor can edit docs" plus a doc ID in the URL is exactly how IDOR/BOLA happens. You still have to check that this doc belongs to this user. OWASP's rule is enforce record ownership, deny by default.

- **Grant least privilege and fail closed.** Give the narrowest role or policy that works, and make a missing or errored rule deny rather than allow. Most access-control disasters are a default that failed open.
- **ABAC and ReBAC policies are code, and untested policy silently over-permits.** Write unit and integration tests for the allow and deny paths the way you would for any branch.
- **Attribute freshness bites ABAC.** A decision is only as correct as the attributes feeding it, so a stale department or a cached manager relationship grants access that should already be gone. Watch where the PIP reads from and how long it caches.

## Revise next
- [OWASP Top 10:2025 A01](owasp-top-10.md) (Broken Access Control)
- [Object-level authorization / IDOR (BOLA)](owasp-api-top-10.md)
- [AuthN vs AuthZ](../api-design/authn-authz-oauth-jwt.md)
- Policy engines: OPA, Cedar, OpenFGA
- [JWT pitfalls](jwt-pitfalls.md): why roles baked into a token go stale, and what revocation costs

*Reviewed against OWASP Top 10:2025 (A01 Broken Access Control) and the OWASP Authorization Cheat Sheet, July 2026.*
