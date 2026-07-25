---
title: "Shallow vs Deep Copy"
group: "Memory"
order: 15
---

# Shallow Copy vs Deep Copy in Python

> **Core idea:** Python variables store references to objects.  
> A **shallow copy** creates a new outer object but reuses nested objects.  
> A **deep copy** recursively creates independent copies of nested objects.

---

## Table of Contents

1. [Why Copying Matters](#1-why-copying-matters)
2. [Assignment Is Not Copying](#2-assignment-is-not-copying)
3. [Shallow Copy](#3-shallow-copy)
4. [Deep Copy](#4-deep-copy)
5. [Shallow Copy vs Deep Copy](#5-shallow-copy-vs-deep-copy)
6. [Common Ways to Copy Built-in Collections](#6-common-ways-to-copy-built-in-collections)
7. [How Immutable Objects Affect Copying](#7-how-immutable-objects-affect-copying)
8. [Practical Development Examples](#8-practical-development-examples)
9. [Copying Custom Classes](#9-copying-custom-classes)
10. [How `deepcopy()` Handles Cycles and Shared References](#10-how-deepcopy-handles-cycles-and-shared-references)
11. [Performance Considerations](#11-performance-considerations)
12. [Choosing the Correct Approach](#12-choosing-the-correct-approach)
13. [Best Practices](#13-best-practices)
14. [Quick Revision](#14-quick-revision)

---

# 1. Why Copying Matters

Copying becomes important when you need to modify data without changing the original object.

This commonly happens with:

- API request or response payloads
- Application configuration
- Nested dictionaries and lists
- Cached data
- Test fixtures
- Domain models
- Background job payloads
- Template objects used to create new records

Consider this nested dictionary:

```python
user = {
    "name": "Avadh",
    "skills": ["Python", "Django"],
}
```

It contains:

- An outer dictionary
- A string value
- A nested list

The outer dictionary and nested list are separate objects. This is why copying only the outer dictionary may not be enough.

---

# 2. Assignment Is Not Copying

The assignment operator `=` does not create a new object. It creates another reference to the same object.

```python
original = ["Python", "Django"]
duplicate = original

duplicate.append("FastAPI")

print(original)
print(duplicate)
```

Output:

```text
['Python', 'Django', 'FastAPI']
['Python', 'Django', 'FastAPI']
```

Both variables refer to the same list.

```mermaid
flowchart LR
    A["original"] --> L["List object<br/>Python, Django"]
    B["duplicate"] --> L
```

You can verify this with `is`:

```python
print(original is duplicate)
```

Output:

```text
True
```

The `is` operator checks object identity, not value equality.

```python
a = [1, 2]
b = [1, 2]

print(a == b)  # Same values
print(a is b)  # Different objects
```

Output:

```text
True
False
```

> [!IMPORTANT]
> Use `==` to compare values.  
> Use `is` to check whether two references point to the exact same object.

---

# 3. Shallow Copy

A shallow copy creates:

- A new outer container
- References to the same nested objects

Use `copy.copy()`:

```python
import copy

original = {
    "name": "Avadh",
    "skills": ["Python", "Django"],
}

shallow = copy.copy(original)
```

The outer dictionaries are different:

```python
print(original is shallow)
```

Output:

```text
False
```

But their nested lists are shared:

```python
print(original["skills"] is shallow["skills"])
```

Output:

```text
True
```

## 3.1 Memory Structure

```mermaid
flowchart LR
    O["original dictionary"] --> N1["name: Avadh"]
    O --> S["skills list<br/>Python, Django"]

    C["shallow dictionary"] --> N2["name: Avadh"]
    C --> S
```

The outer dictionary was copied, but both dictionaries still reference the same `skills` list.

## 3.2 Changing the Outer Object

Replacing a top-level value affects only the copied dictionary:

```python
import copy

original = {
    "name": "Avadh",
    "skills": ["Python", "Django"],
}

shallow = copy.copy(original)
shallow["name"] = "Rahul"

print(original["name"])
print(shallow["name"])
```

Output:

```text
Avadh
Rahul
```

This works independently because the outer dictionaries are separate.

## 3.3 Changing a Nested Mutable Object

Modifying the shared nested list affects both objects:

```python
shallow["skills"].append("FastAPI")

print(original["skills"])
print(shallow["skills"])
```

Output:

```text
['Python', 'Django', 'FastAPI']
['Python', 'Django', 'FastAPI']
```

The nested list was not copied.

## 3.4 Important Rule

> A shallow copy provides independence only at the first level.

This is safe when:

- The object is flat
- Nested values are immutable
- Sharing nested objects is intentional
- Nested objects will not be modified

---

# 4. Deep Copy

A deep copy creates:

- A new outer object
- New copies of nested mutable objects
- Recursively independent object structures

Use `copy.deepcopy()`:

```python
import copy

original = {
    "name": "Avadh",
    "skills": ["Python", "Django"],
}

deep = copy.deepcopy(original)
```

The outer dictionaries are different:

```python
print(original is deep)
```

Output:

```text
False
```

The nested lists are also different:

```python
print(original["skills"] is deep["skills"])
```

Output:

```text
False
```

## 4.1 Memory Structure

```mermaid
flowchart LR
    O["original dictionary"] --> N1["name: Avadh"]
    O --> S1["skills list<br/>Python, Django"]

    D["deep-copy dictionary"] --> N2["name: Avadh"]
    D --> S2["new skills list<br/>Python, Django"]
```

## 4.2 Modifying Nested Data

```python
import copy

original = {
    "name": "Avadh",
    "skills": ["Python", "Django"],
}

deep = copy.deepcopy(original)
deep["skills"].append("FastAPI")

print(original["skills"])
print(deep["skills"])
```

Output:

```text
['Python', 'Django']
['Python', 'Django', 'FastAPI']
```

The original object remains unchanged.

## 4.3 Important Rule

> A deep copy provides recursive independence for copied mutable objects.

Use it when:

- Nested data must be modified independently
- The original object must remain unchanged
- The structure contains several mutable levels
- You are creating isolated test data or configuration

---

# 5. Shallow Copy vs Deep Copy

| Behavior | Assignment | Shallow Copy | Deep Copy |
|---|---:|---:|---:|
| Creates a new outer object | No | Yes | Yes |
| Copies nested objects | No | No | Yes, recursively |
| Shares nested mutable data | Yes | Yes | Usually no |
| Faster | Fastest | Usually fast | Usually slower |
| Lower memory usage | Yes | Usually | No |
| Original nested data is protected | No | No | Yes |
| Typical syntax | `b = a` | `copy.copy(a)` | `copy.deepcopy(a)` |

## 5.1 One Example Showing All Three

```python
import copy

original = {
    "project": "Backend API",
    "members": [
        {"name": "Asha", "role": "Developer"},
        {"name": "Ravi", "role": "Tester"},
    ],
}

assigned = original
shallow = copy.copy(original)
deep = copy.deepcopy(original)

print(assigned is original)
print(shallow is original)
print(deep is original)

print(shallow["members"] is original["members"])
print(deep["members"] is original["members"])
```

Output:

```text
True
False
False
True
False
```

Now modify a nested value:

```python
shallow["members"][0]["role"] = "Tech Lead"

print(original["members"][0]["role"])
```

Output:

```text
Tech Lead
```

The change appears in `original` because the nested structure is shared.

With a deep copy:

```python
deep["members"][0]["role"] = "Architect"

print(original["members"][0]["role"])
print(deep["members"][0]["role"])
```

Output:

```text
Tech Lead
Architect
```

---

# 6. Common Ways to Copy Built-in Collections

Python provides several shallow-copy techniques.

## 6.1 Lists

### Using `list.copy()`

```python
original = [1, 2, 3]
copied = original.copy()
```

### Using slicing

```python
copied = original[:]
```

### Using the constructor

```python
copied = list(original)
```

### Using `copy.copy()`

```python
import copy

copied = copy.copy(original)
```

All of these create shallow copies.

## 6.2 Dictionaries

```python
original = {"name": "Avadh", "skills": ["Python"]}

copy_1 = original.copy()
copy_2 = dict(original)
```

Both are shallow copies.

## 6.3 Sets

```python
original = {"Python", "Django"}

copy_1 = original.copy()
copy_2 = set(original)
```

Both create a new set.

## 6.4 Nested Collections Still Share Objects

```python
original = [[1, 2], [3, 4]]
copied = original[:]

copied[0].append(99)

print(original)
```

Output:

```text
[[1, 2, 99], [3, 4]]
```

Slicing copied the outer list only.

```mermaid
flowchart LR
    O["original list"] --> A["nested list: 1, 2"]
    O --> B["nested list: 3, 4"]

    C["sliced list"] --> A
    C --> B
```

---

# 7. How Immutable Objects Affect Copying

Common immutable types include:

- `int`
- `float`
- `bool`
- `str`
- `bytes`
- `frozenset`
- Most tuples, depending on their contents

Immutable objects cannot be changed in place. Therefore, sharing them is normally safe.

```python
import copy

original = {
    "name": "Avadh",
    "experience": 3,
}

shallow = copy.copy(original)

print(original["name"] is shallow["name"])
print(original["experience"] is shallow["experience"])
```

The references may be shared, but this is not normally a problem because strings and integers cannot be mutated.

## 7.1 Tuple Edge Case

A tuple is immutable, but it can contain a mutable object:

```python
data = ("Python", ["Django", "FastAPI"])
```

You cannot replace an element of the tuple:

```python
# data[0] = "Java"  # TypeError
```

But you can modify its nested list:

```python
data[1].append("Flask")

print(data)
```

Output:

```text
('Python', ['Django', 'FastAPI', 'Flask'])
```

A container being immutable does not guarantee that everything inside it is immutable.

---

# 8. Practical Development Examples

## 8.1 API Payload Modification

Suppose a service receives a nested payload:

```python
request_payload = {
    "customer": {
        "name": "Asha",
        "contact": {
            "email": "asha@example.com",
        },
    },
    "items": [
        {"product_id": 101, "quantity": 2},
    ],
}
```

You want to add internal processing data without changing the original request.

A shallow copy is not enough:

```python
import copy

processing_payload = copy.copy(request_payload)
processing_payload["customer"]["contact"]["verified"] = True

print(request_payload["customer"]["contact"])
```

Output:

```text
{'email': 'asha@example.com', 'verified': True}
```

Use a deep copy when full isolation is required:

```python
processing_payload = copy.deepcopy(request_payload)
processing_payload["customer"]["contact"]["verified"] = True
```

Now `request_payload` remains unchanged.

## 8.2 Configuration Templates

```python
import copy

default_config = {
    "database": {
        "host": "localhost",
        "port": 5432,
    },
    "features": {
        "audit_logs": True,
        "notifications": ["email"],
    },
}

tenant_config = copy.deepcopy(default_config)
tenant_config["database"]["host"] = "tenant-db.internal"
tenant_config["features"]["notifications"].append("sms")
```

A deep copy is useful because each tenant should have an independent configuration.

## 8.3 Test Fixtures

```python
import copy

BASE_USER = {
    "name": "Test User",
    "permissions": ["read"],
    "profile": {
        "active": True,
    },
}

def build_test_user() -> dict:
    return copy.deepcopy(BASE_USER)
```

Each test receives isolated data:

```python
admin = build_test_user()
admin["permissions"].append("write")

regular = build_test_user()

print(regular["permissions"])
```

Output:

```text
['read']
```

Without a deep copy, one test could accidentally affect another.

## 8.4 Selective Copying Instead of Full Deep Copy

A full deep copy is not always required.

Suppose only one nested list needs to be modified:

```python
original = {
    "name": "Project Alpha",
    "tags": ["backend", "python"],
    "owner": {
        "id": 10,
        "name": "Asha",
    },
}
```

You can selectively copy the changed path:

```python
updated = {
    **original,
    "tags": original["tags"].copy(),
}

updated["tags"].append("api")
```

Now:

- The outer dictionary is new
- The `tags` list is new
- The unchanged `owner` dictionary is shared

This is often more efficient than copying the entire object graph.

```mermaid
flowchart LR
    O["original"] --> T1["original tags"]
    O --> OWNER["shared owner"]

    U["updated"] --> T2["copied tags"]
    U --> OWNER
```

This technique is common in state-management and data-transformation code.

---

# 9. Copying Custom Classes

The `copy` module can copy instances of custom classes.

```python
import copy

class Project:
    def __init__(self, name: str, members: list[str]) -> None:
        self.name = name
        self.members = members


original = Project("Payment API", ["Asha", "Ravi"])

shallow = copy.copy(original)
deep = copy.deepcopy(original)
```

Object identity:

```python
print(original is shallow)
print(original is deep)
```

Output:

```text
False
False
```

Nested list identity:

```python
print(original.members is shallow.members)
print(original.members is deep.members)
```

Output:

```text
True
False
```

## 9.1 Customizing Shallow Copy with `__copy__()`

A class can define its own shallow-copy behavior:

```python
import copy

class Project:
    def __init__(self, name: str, members: list[str]) -> None:
        self.name = name
        self.members = members

    def __copy__(self) -> "Project":
        new_project = type(self)(
            name=self.name,
            members=self.members,
        )
        return new_project


project = Project("Payment API", ["Asha", "Ravi"])
copied_project = copy.copy(project)
```

The method should return the desired shallow copy.

## 9.2 Customizing Deep Copy with `__deepcopy__()`

```python
import copy

class Project:
    def __init__(self, name: str, members: list[str]) -> None:
        self.name = name
        self.members = members

    def __deepcopy__(self, memo: dict[int, object]) -> "Project":
        existing = memo.get(id(self))

        if existing is not None:
            return existing  # type: ignore[return-value]

        new_project = type(self).__new__(type(self))
        memo[id(self)] = new_project

        new_project.name = copy.deepcopy(self.name, memo)
        new_project.members = copy.deepcopy(self.members, memo)

        return new_project
```

The `memo` dictionary is important because it:

- Prevents infinite recursion
- Preserves shared-reference relationships
- Avoids repeatedly copying the same object

> [!NOTE]
> Custom copy methods are useful when a class contains resources that should not be duplicated, such as database connections, locks, open files, sockets, or framework-managed objects.

---

# 10. How `deepcopy()` Handles Cycles and Shared References

Deep copying is more complex than recursively calling `copy()` on every value.

## 10.1 Circular References

An object may indirectly refer back to itself:

```python
data = []
data.append(data)
```

Structure:

```mermaid
flowchart LR
    A["data list"] --> A
```

A naive recursive copy would run forever.

Python's `deepcopy()` uses an internal memo dictionary to remember objects that have already been copied:

```python
import copy

cloned = copy.deepcopy(data)

print(cloned is cloned[0])
```

Output:

```text
True
```

The circular structure is preserved safely.

## 10.2 Shared References Are Preserved

Consider two keys referencing the same list:

```python
shared_permissions = ["read"]

user = {
    "direct_permissions": shared_permissions,
    "role_permissions": shared_permissions,
}
```

After deep copying:

```python
import copy

copied_user = copy.deepcopy(user)

print(
    copied_user["direct_permissions"]
    is copied_user["role_permissions"]
)
```

Output:

```text
True
```

`deepcopy()` creates one copied permissions list and reuses it within the new object graph.

The copied list is still independent from the original:

```python
print(
    copied_user["direct_permissions"]
    is shared_permissions
)
```

Output:

```text
False
```

```mermaid
flowchart LR
    O1["original key 1"] --> L1["original shared list"]
    O2["original key 2"] --> L1

    C1["copied key 1"] --> L2["new shared list"]
    C2["copied key 2"] --> L2
```

---

# 11. Performance Considerations

A deep copy usually requires more CPU time and memory because it traverses the object graph recursively.

## 11.1 General Cost

| Operation | Time Cost | Memory Cost |
|---|---:|---:|
| Assignment | Very low | Very low |
| Shallow copy | Proportional to outer container | New outer container |
| Deep copy | Proportional to copied object graph | New copied graph |

These are conceptual costs. Actual performance depends on:

- Number of objects
- Nesting depth
- Object types
- Custom copy methods
- Circular and shared references
- Expensive user-defined objects

## 11.2 Deep Copy Can Copy More Than Needed

```python
large_state = {
    "users": [...],
    "settings": {...},
    "cache": {...},
    "current_page": 1,
}
```

If only `current_page` changes, deep copying the entire state is unnecessary:

```python
updated_state = {
    **large_state,
    "current_page": 2,
}
```

Use the smallest amount of copying required for safe isolation.

## 11.3 Some Objects Should Not Be Deep-Copied

Objects representing external resources may not support meaningful copying:

- Database connections
- File handles
- Network sockets
- Thread locks
- Generators
- Modules
- Runtime or framework contexts

Instead of copying such objects, create a new domain object with only the required plain data.

---

# 12. Choosing the Correct Approach

Use the following decision flow:

```mermaid
flowchart TD
    A["Do you need another reference<br/>to the same object?"] -->|Yes| B["Use assignment: b = a"]
    A -->|No| C["Does the object contain<br/>nested mutable values?"]

    C -->|No| D["Use a shallow copy"]
    C -->|Yes| E["Will nested values be modified?"]

    E -->|No| F["Shallow copy may be enough"]
    E -->|Yes| G["Must every nested object<br/>be independent?"]

    G -->|Yes| H["Use deepcopy()"]
    G -->|No| I["Selectively copy only<br/>the modified paths"]
```

## 12.1 Use Assignment When

```python
alias = original
```

Choose assignment when:

- Shared state is intentional
- Both names should observe the same changes
- No independent object is required

## 12.2 Use a Shallow Copy When

```python
copied = original.copy()
```

Choose a shallow copy when:

- The structure is flat
- Nested values are immutable
- Nested sharing is intentional
- Only top-level keys or items will change

## 12.3 Use a Deep Copy When

```python
import copy

copied = copy.deepcopy(original)
```

Choose a deep copy when:

- Nested mutable objects will change
- Full isolation is required
- The object graph is suitable for duplication
- The additional memory and processing cost is acceptable

## 12.4 Use Selective Copying When

```python
updated = {
    **original,
    "items": original["items"].copy(),
}
```

Choose selective copying when:

- Only a known part of a large structure changes
- You want explicit ownership of copied paths
- Full deep copying would be expensive or unclear

---

# 13. Best Practices

## 13.1 Understand the Object Structure First

Before choosing a copy strategy, identify:

- Which objects are mutable
- Which nested objects are shared
- Which parts will be changed
- Whether shared state is intentional

## 13.2 Prefer Explicit Copying

For built-in collections, explicit methods are often readable:

```python
users_copy = users.copy()
config_copy = config.copy()
tags_copy = tags.copy()
```

Use `copy.copy()` when you need a generic shallow-copy operation across object types.

## 13.3 Do Not Use `deepcopy()` Automatically

`deepcopy()` is useful, but it can:

- Consume significant memory
- Hide unclear ownership
- Copy unnecessary data
- Interact unexpectedly with custom classes
- Fail for objects tied to external resources

Use it because full recursive isolation is required, not merely as a defensive habit.

## 13.4 Prefer Immutable Data Where Practical

Immutable values reduce copying concerns.

For example, prefer a tuple when a collection should never change:

```python
SUPPORTED_ROLES = ("admin", "developer", "tester")
```

## 13.5 Copy at Clear Boundaries

Useful copying boundaries include:

- Before modifying cached data
- When constructing test fixtures
- When converting external input into internal state
- When creating an independent configuration
- When passing mutable data to code that may modify it

## 13.6 Verify Important Assumptions

Use identity checks during debugging:

```python
assert original is not copied
assert original["items"] is not copied["items"]
```

This makes ownership expectations explicit in tests.

---

# 14. Quick Revision

## Assignment

```python
copied = original
```

- No new object
- Same outer object
- Same nested objects
- Changes are shared

## Shallow Copy

```python
import copy

copied = copy.copy(original)
```

- New outer object
- Same nested objects
- Top-level replacement is independent
- Nested mutation may affect both objects

## Deep Copy

```python
import copy

copied = copy.deepcopy(original)
```

- New outer object
- Recursively copied nested objects
- Nested mutation is normally independent
- Higher time and memory cost

## Final Mental Model

```text
Assignment:
new variable ───────► original object

Shallow copy:
new variable ───────► new outer object
                          │
                          └────► shared nested objects

Deep copy:
new variable ───────► new outer object
                          │
                          └────► new nested objects
```

> [!KEY]
> Do not choose a copy type based only on whether the outer object is a list or dictionary.  
> Choose it based on the complete nested structure and which parts your code will mutate.

---

# References

- Python `copy` module: <https://docs.python.org/3/library/copy.html>
- Python data model: <https://docs.python.org/3/reference/datamodel.html>
