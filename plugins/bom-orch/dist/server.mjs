#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS({
  "node_modules/ajv/dist/compile/codegen/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
    var _CodeOrName = class {
    };
    exports._CodeOrName = _CodeOrName;
    exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
    var Name = class extends _CodeOrName {
      constructor(s) {
        super();
        if (!exports.IDENTIFIER.test(s))
          throw new Error("CodeGen: name must be a valid identifier");
        this.str = s;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        return false;
      }
      get names() {
        return { [this.str]: 1 };
      }
    };
    exports.Name = Name;
    var _Code = class extends _CodeOrName {
      constructor(code) {
        super();
        this._items = typeof code === "string" ? [code] : code;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        if (this._items.length > 1)
          return false;
        const item = this._items[0];
        return item === "" || item === '""';
      }
      get str() {
        var _a3;
        return (_a3 = this._str) !== null && _a3 !== void 0 ? _a3 : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
      }
      get names() {
        var _a3;
        return (_a3 = this._names) !== null && _a3 !== void 0 ? _a3 : this._names = this._items.reduce((names, c) => {
          if (c instanceof Name)
            names[c.str] = (names[c.str] || 0) + 1;
          return names;
        }, {});
      }
    };
    exports._Code = _Code;
    exports.nil = new _Code("");
    function _(strs, ...args) {
      const code = [strs[0]];
      let i = 0;
      while (i < args.length) {
        addCodeArg(code, args[i]);
        code.push(strs[++i]);
      }
      return new _Code(code);
    }
    exports._ = _;
    var plus = new _Code("+");
    function str(strs, ...args) {
      const expr = [safeStringify(strs[0])];
      let i = 0;
      while (i < args.length) {
        expr.push(plus);
        addCodeArg(expr, args[i]);
        expr.push(plus, safeStringify(strs[++i]));
      }
      optimize(expr);
      return new _Code(expr);
    }
    exports.str = str;
    function addCodeArg(code, arg) {
      if (arg instanceof _Code)
        code.push(...arg._items);
      else if (arg instanceof Name)
        code.push(arg);
      else
        code.push(interpolate(arg));
    }
    exports.addCodeArg = addCodeArg;
    function optimize(expr) {
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === plus) {
          const res = mergeExprItems(expr[i - 1], expr[i + 1]);
          if (res !== void 0) {
            expr.splice(i - 1, 3, res);
            continue;
          }
          expr[i++] = "+";
        }
        i++;
      }
    }
    function mergeExprItems(a, b) {
      if (b === '""')
        return a;
      if (a === '""')
        return b;
      if (typeof a == "string") {
        if (b instanceof Name || a[a.length - 1] !== '"')
          return;
        if (typeof b != "string")
          return `${a.slice(0, -1)}${b}"`;
        if (b[0] === '"')
          return a.slice(0, -1) + b.slice(1);
        return;
      }
      if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
        return `"${a}${b.slice(1)}`;
      return;
    }
    function strConcat(c1, c2) {
      return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
    }
    exports.strConcat = strConcat;
    function interpolate(x) {
      return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
    }
    function stringify(x) {
      return new _Code(safeStringify(x));
    }
    exports.stringify = stringify;
    function safeStringify(x) {
      return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    exports.safeStringify = safeStringify;
    function getProperty(key) {
      return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
    }
    exports.getProperty = getProperty;
    function getEsmExportName(key) {
      if (typeof key == "string" && exports.IDENTIFIER.test(key)) {
        return new _Code(`${key}`);
      }
      throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
    }
    exports.getEsmExportName = getEsmExportName;
    function regexpCode(rx) {
      return new _Code(rx.toString());
    }
    exports.regexpCode = regexpCode;
  }
});

// node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS({
  "node_modules/ajv/dist/compile/codegen/scope.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
    var code_1 = require_code();
    var ValueError = class extends Error {
      constructor(name) {
        super(`CodeGen: "code" for ${name} not defined`);
        this.value = name.value;
      }
    };
    var UsedValueState;
    (function(UsedValueState2) {
      UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
      UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
    })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
    exports.varKinds = {
      const: new code_1.Name("const"),
      let: new code_1.Name("let"),
      var: new code_1.Name("var")
    };
    var Scope = class {
      constructor({ prefixes, parent } = {}) {
        this._names = {};
        this._prefixes = prefixes;
        this._parent = parent;
      }
      toName(nameOrPrefix) {
        return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
      }
      name(prefix) {
        return new code_1.Name(this._newName(prefix));
      }
      _newName(prefix) {
        const ng = this._names[prefix] || this._nameGroup(prefix);
        return `${prefix}${ng.index++}`;
      }
      _nameGroup(prefix) {
        var _a3, _b;
        if (((_b = (_a3 = this._parent) === null || _a3 === void 0 ? void 0 : _a3._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
          throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
        }
        return this._names[prefix] = { prefix, index: 0 };
      }
    };
    exports.Scope = Scope;
    var ValueScopeName = class extends code_1.Name {
      constructor(prefix, nameStr) {
        super(nameStr);
        this.prefix = prefix;
      }
      setValue(value, { property, itemIndex }) {
        this.value = value;
        this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
      }
    };
    exports.ValueScopeName = ValueScopeName;
    var line = (0, code_1._)`\n`;
    var ValueScope = class extends Scope {
      constructor(opts) {
        super(opts);
        this._values = {};
        this._scope = opts.scope;
        this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
      }
      get() {
        return this._scope;
      }
      name(prefix) {
        return new ValueScopeName(prefix, this._newName(prefix));
      }
      value(nameOrPrefix, value) {
        var _a3;
        if (value.ref === void 0)
          throw new Error("CodeGen: ref must be passed in value");
        const name = this.toName(nameOrPrefix);
        const { prefix } = name;
        const valueKey = (_a3 = value.key) !== null && _a3 !== void 0 ? _a3 : value.ref;
        let vs = this._values[prefix];
        if (vs) {
          const _name = vs.get(valueKey);
          if (_name)
            return _name;
        } else {
          vs = this._values[prefix] = /* @__PURE__ */ new Map();
        }
        vs.set(valueKey, name);
        const s = this._scope[prefix] || (this._scope[prefix] = []);
        const itemIndex = s.length;
        s[itemIndex] = value.ref;
        name.setValue(value, { property: prefix, itemIndex });
        return name;
      }
      getValue(prefix, keyOrRef) {
        const vs = this._values[prefix];
        if (!vs)
          return;
        return vs.get(keyOrRef);
      }
      scopeRefs(scopeName, values = this._values) {
        return this._reduceValues(values, (name) => {
          if (name.scopePath === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return (0, code_1._)`${scopeName}${name.scopePath}`;
        });
      }
      scopeCode(values = this._values, usedValues, getCode) {
        return this._reduceValues(values, (name) => {
          if (name.value === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return name.value.code;
        }, usedValues, getCode);
      }
      _reduceValues(values, valueCode, usedValues = {}, getCode) {
        let code = code_1.nil;
        for (const prefix in values) {
          const vs = values[prefix];
          if (!vs)
            continue;
          const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
          vs.forEach((name) => {
            if (nameSet.has(name))
              return;
            nameSet.set(name, UsedValueState.Started);
            let c = valueCode(name);
            if (c) {
              const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
              code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
            } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) {
              code = (0, code_1._)`${code}${c}${this.opts._n}`;
            } else {
              throw new ValueError(name);
            }
            nameSet.set(name, UsedValueState.Completed);
          });
        }
        return code;
      }
    };
    exports.ValueScope = ValueScope;
  }
});

// node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS({
  "node_modules/ajv/dist/compile/codegen/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
    var code_1 = require_code();
    var scope_1 = require_scope();
    var code_2 = require_code();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return code_2._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return code_2.str;
    } });
    Object.defineProperty(exports, "strConcat", { enumerable: true, get: function() {
      return code_2.strConcat;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return code_2.nil;
    } });
    Object.defineProperty(exports, "getProperty", { enumerable: true, get: function() {
      return code_2.getProperty;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return code_2.stringify;
    } });
    Object.defineProperty(exports, "regexpCode", { enumerable: true, get: function() {
      return code_2.regexpCode;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return code_2.Name;
    } });
    var scope_2 = require_scope();
    Object.defineProperty(exports, "Scope", { enumerable: true, get: function() {
      return scope_2.Scope;
    } });
    Object.defineProperty(exports, "ValueScope", { enumerable: true, get: function() {
      return scope_2.ValueScope;
    } });
    Object.defineProperty(exports, "ValueScopeName", { enumerable: true, get: function() {
      return scope_2.ValueScopeName;
    } });
    Object.defineProperty(exports, "varKinds", { enumerable: true, get: function() {
      return scope_2.varKinds;
    } });
    exports.operators = {
      GT: new code_1._Code(">"),
      GTE: new code_1._Code(">="),
      LT: new code_1._Code("<"),
      LTE: new code_1._Code("<="),
      EQ: new code_1._Code("==="),
      NEQ: new code_1._Code("!=="),
      NOT: new code_1._Code("!"),
      OR: new code_1._Code("||"),
      AND: new code_1._Code("&&"),
      ADD: new code_1._Code("+")
    };
    var Node = class {
      optimizeNodes() {
        return this;
      }
      optimizeNames(_names, _constants) {
        return this;
      }
    };
    var Def = class extends Node {
      constructor(varKind, name, rhs) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.rhs = rhs;
      }
      render({ es5, _n }) {
        const varKind = es5 ? scope_1.varKinds.var : this.varKind;
        const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
        return `${varKind} ${this.name}${rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (!names[this.name.str])
          return;
        if (this.rhs)
          this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
      }
    };
    var Assign = class extends Node {
      constructor(lhs, rhs, sideEffects) {
        super();
        this.lhs = lhs;
        this.rhs = rhs;
        this.sideEffects = sideEffects;
      }
      render({ _n }) {
        return `${this.lhs} = ${this.rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
          return;
        this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
        return addExprNames(names, this.rhs);
      }
    };
    var AssignOp = class extends Assign {
      constructor(lhs, op, rhs, sideEffects) {
        super(lhs, rhs, sideEffects);
        this.op = op;
      }
      render({ _n }) {
        return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
      }
    };
    var Label = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        return `${this.label}:` + _n;
      }
    };
    var Break = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        const label = this.label ? ` ${this.label}` : "";
        return `break${label};` + _n;
      }
    };
    var Throw = class extends Node {
      constructor(error2) {
        super();
        this.error = error2;
      }
      render({ _n }) {
        return `throw ${this.error};` + _n;
      }
      get names() {
        return this.error.names;
      }
    };
    var AnyCode = class extends Node {
      constructor(code) {
        super();
        this.code = code;
      }
      render({ _n }) {
        return `${this.code};` + _n;
      }
      optimizeNodes() {
        return `${this.code}` ? this : void 0;
      }
      optimizeNames(names, constants) {
        this.code = optimizeExpr(this.code, names, constants);
        return this;
      }
      get names() {
        return this.code instanceof code_1._CodeOrName ? this.code.names : {};
      }
    };
    var ParentNode = class extends Node {
      constructor(nodes = []) {
        super();
        this.nodes = nodes;
      }
      render(opts) {
        return this.nodes.reduce((code, n) => code + n.render(opts), "");
      }
      optimizeNodes() {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i].optimizeNodes();
          if (Array.isArray(n))
            nodes.splice(i, 1, ...n);
          else if (n)
            nodes[i] = n;
          else
            nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      optimizeNames(names, constants) {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i];
          if (n.optimizeNames(names, constants))
            continue;
          subtractNames(names, n.names);
          nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      get names() {
        return this.nodes.reduce((names, n) => addNames(names, n.names), {});
      }
    };
    var BlockNode = class extends ParentNode {
      render(opts) {
        return "{" + opts._n + super.render(opts) + "}" + opts._n;
      }
    };
    var Root = class extends ParentNode {
    };
    var Else = class extends BlockNode {
    };
    Else.kind = "else";
    var If = class _If extends BlockNode {
      constructor(condition, nodes) {
        super(nodes);
        this.condition = condition;
      }
      render(opts) {
        let code = `if(${this.condition})` + super.render(opts);
        if (this.else)
          code += "else " + this.else.render(opts);
        return code;
      }
      optimizeNodes() {
        super.optimizeNodes();
        const cond = this.condition;
        if (cond === true)
          return this.nodes;
        let e = this.else;
        if (e) {
          const ns = e.optimizeNodes();
          e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
        }
        if (e) {
          if (cond === false)
            return e instanceof _If ? e : e.nodes;
          if (this.nodes.length)
            return this;
          return new _If(not(cond), e instanceof _If ? [e] : e.nodes);
        }
        if (cond === false || !this.nodes.length)
          return void 0;
        return this;
      }
      optimizeNames(names, constants) {
        var _a3;
        this.else = (_a3 = this.else) === null || _a3 === void 0 ? void 0 : _a3.optimizeNames(names, constants);
        if (!(super.optimizeNames(names, constants) || this.else))
          return;
        this.condition = optimizeExpr(this.condition, names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        addExprNames(names, this.condition);
        if (this.else)
          addNames(names, this.else.names);
        return names;
      }
    };
    If.kind = "if";
    var For = class extends BlockNode {
    };
    For.kind = "for";
    var ForLoop = class extends For {
      constructor(iteration) {
        super();
        this.iteration = iteration;
      }
      render(opts) {
        return `for(${this.iteration})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iteration = optimizeExpr(this.iteration, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iteration.names);
      }
    };
    var ForRange = class extends For {
      constructor(varKind, name, from, to) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.from = from;
        this.to = to;
      }
      render(opts) {
        const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
        const { name, from, to } = this;
        return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
      }
      get names() {
        const names = addExprNames(super.names, this.from);
        return addExprNames(names, this.to);
      }
    };
    var ForIter = class extends For {
      constructor(loop, varKind, name, iterable) {
        super();
        this.loop = loop;
        this.varKind = varKind;
        this.name = name;
        this.iterable = iterable;
      }
      render(opts) {
        return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iterable = optimizeExpr(this.iterable, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iterable.names);
      }
    };
    var Func = class extends BlockNode {
      constructor(name, args, async) {
        super();
        this.name = name;
        this.args = args;
        this.async = async;
      }
      render(opts) {
        const _async = this.async ? "async " : "";
        return `${_async}function ${this.name}(${this.args})` + super.render(opts);
      }
    };
    Func.kind = "func";
    var Return = class extends ParentNode {
      render(opts) {
        return "return " + super.render(opts);
      }
    };
    Return.kind = "return";
    var Try = class extends BlockNode {
      render(opts) {
        let code = "try" + super.render(opts);
        if (this.catch)
          code += this.catch.render(opts);
        if (this.finally)
          code += this.finally.render(opts);
        return code;
      }
      optimizeNodes() {
        var _a3, _b;
        super.optimizeNodes();
        (_a3 = this.catch) === null || _a3 === void 0 ? void 0 : _a3.optimizeNodes();
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNodes();
        return this;
      }
      optimizeNames(names, constants) {
        var _a3, _b;
        super.optimizeNames(names, constants);
        (_a3 = this.catch) === null || _a3 === void 0 ? void 0 : _a3.optimizeNames(names, constants);
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNames(names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        if (this.catch)
          addNames(names, this.catch.names);
        if (this.finally)
          addNames(names, this.finally.names);
        return names;
      }
    };
    var Catch = class extends BlockNode {
      constructor(error2) {
        super();
        this.error = error2;
      }
      render(opts) {
        return `catch(${this.error})` + super.render(opts);
      }
    };
    Catch.kind = "catch";
    var Finally = class extends BlockNode {
      render(opts) {
        return "finally" + super.render(opts);
      }
    };
    Finally.kind = "finally";
    var CodeGen = class {
      constructor(extScope, opts = {}) {
        this._values = {};
        this._blockStarts = [];
        this._constants = {};
        this.opts = { ...opts, _n: opts.lines ? "\n" : "" };
        this._extScope = extScope;
        this._scope = new scope_1.Scope({ parent: extScope });
        this._nodes = [new Root()];
      }
      toString() {
        return this._root.render(this.opts);
      }
      // returns unique name in the internal scope
      name(prefix) {
        return this._scope.name(prefix);
      }
      // reserves unique name in the external scope
      scopeName(prefix) {
        return this._extScope.name(prefix);
      }
      // reserves unique name in the external scope and assigns value to it
      scopeValue(prefixOrName, value) {
        const name = this._extScope.value(prefixOrName, value);
        const vs = this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set());
        vs.add(name);
        return name;
      }
      getScopeValue(prefix, keyOrRef) {
        return this._extScope.getValue(prefix, keyOrRef);
      }
      // return code that assigns values in the external scope to the names that are used internally
      // (same names that were returned by gen.scopeName or gen.scopeValue)
      scopeRefs(scopeName) {
        return this._extScope.scopeRefs(scopeName, this._values);
      }
      scopeCode() {
        return this._extScope.scopeCode(this._values);
      }
      _def(varKind, nameOrPrefix, rhs, constant) {
        const name = this._scope.toName(nameOrPrefix);
        if (rhs !== void 0 && constant)
          this._constants[name.str] = rhs;
        this._leafNode(new Def(varKind, name, rhs));
        return name;
      }
      // `const` declaration (`var` in es5 mode)
      const(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
      }
      // `let` declaration with optional assignment (`var` in es5 mode)
      let(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
      }
      // `var` declaration with optional assignment
      var(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
      }
      // assignment code
      assign(lhs, rhs, sideEffects) {
        return this._leafNode(new Assign(lhs, rhs, sideEffects));
      }
      // `+=` code
      add(lhs, rhs) {
        return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
      }
      // appends passed SafeExpr to code or executes Block
      code(c) {
        if (typeof c == "function")
          c();
        else if (c !== code_1.nil)
          this._leafNode(new AnyCode(c));
        return this;
      }
      // returns code for object literal for the passed argument list of key-value pairs
      object(...keyValues) {
        const code = ["{"];
        for (const [key, value] of keyValues) {
          if (code.length > 1)
            code.push(",");
          code.push(key);
          if (key !== value || this.opts.es5) {
            code.push(":");
            (0, code_1.addCodeArg)(code, value);
          }
        }
        code.push("}");
        return new code_1._Code(code);
      }
      // `if` clause (or statement if `thenBody` and, optionally, `elseBody` are passed)
      if(condition, thenBody, elseBody) {
        this._blockNode(new If(condition));
        if (thenBody && elseBody) {
          this.code(thenBody).else().code(elseBody).endIf();
        } else if (thenBody) {
          this.code(thenBody).endIf();
        } else if (elseBody) {
          throw new Error('CodeGen: "else" body without "then" body');
        }
        return this;
      }
      // `else if` clause - invalid without `if` or after `else` clauses
      elseIf(condition) {
        return this._elseNode(new If(condition));
      }
      // `else` clause - only valid after `if` or `else if` clauses
      else() {
        return this._elseNode(new Else());
      }
      // end `if` statement (needed if gen.if was used only with condition)
      endIf() {
        return this._endBlockNode(If, Else);
      }
      _for(node, forBody) {
        this._blockNode(node);
        if (forBody)
          this.code(forBody).endFor();
        return this;
      }
      // a generic `for` clause (or statement if `forBody` is passed)
      for(iteration, forBody) {
        return this._for(new ForLoop(iteration), forBody);
      }
      // `for` statement for a range of values
      forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
      }
      // `for-of` statement (in es5 mode replace with a normal for loop)
      forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
        const name = this._scope.toName(nameOrPrefix);
        if (this.opts.es5) {
          const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
          return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
            this.var(name, (0, code_1._)`${arr}[${i}]`);
            forBody(name);
          });
        }
        return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
      }
      // `for-in` statement.
      // With option `ownProperties` replaced with a `for-of` loop for object keys
      forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
        if (this.opts.ownProperties) {
          return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
        }
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
      }
      // end `for` loop
      endFor() {
        return this._endBlockNode(For);
      }
      // `label` statement
      label(label) {
        return this._leafNode(new Label(label));
      }
      // `break` statement
      break(label) {
        return this._leafNode(new Break(label));
      }
      // `return` statement
      return(value) {
        const node = new Return();
        this._blockNode(node);
        this.code(value);
        if (node.nodes.length !== 1)
          throw new Error('CodeGen: "return" should have one node');
        return this._endBlockNode(Return);
      }
      // `try` statement
      try(tryBody, catchCode, finallyCode) {
        if (!catchCode && !finallyCode)
          throw new Error('CodeGen: "try" without "catch" and "finally"');
        const node = new Try();
        this._blockNode(node);
        this.code(tryBody);
        if (catchCode) {
          const error2 = this.name("e");
          this._currNode = node.catch = new Catch(error2);
          catchCode(error2);
        }
        if (finallyCode) {
          this._currNode = node.finally = new Finally();
          this.code(finallyCode);
        }
        return this._endBlockNode(Catch, Finally);
      }
      // `throw` statement
      throw(error2) {
        return this._leafNode(new Throw(error2));
      }
      // start self-balancing block
      block(body, nodeCount) {
        this._blockStarts.push(this._nodes.length);
        if (body)
          this.code(body).endBlock(nodeCount);
        return this;
      }
      // end the current self-balancing block
      endBlock(nodeCount) {
        const len = this._blockStarts.pop();
        if (len === void 0)
          throw new Error("CodeGen: not in self-balancing block");
        const toClose = this._nodes.length - len;
        if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) {
          throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
        }
        this._nodes.length = len;
        return this;
      }
      // `function` heading (or definition if funcBody is passed)
      func(name, args = code_1.nil, async, funcBody) {
        this._blockNode(new Func(name, args, async));
        if (funcBody)
          this.code(funcBody).endFunc();
        return this;
      }
      // end function definition
      endFunc() {
        return this._endBlockNode(Func);
      }
      optimize(n = 1) {
        while (n-- > 0) {
          this._root.optimizeNodes();
          this._root.optimizeNames(this._root.names, this._constants);
        }
      }
      _leafNode(node) {
        this._currNode.nodes.push(node);
        return this;
      }
      _blockNode(node) {
        this._currNode.nodes.push(node);
        this._nodes.push(node);
      }
      _endBlockNode(N1, N2) {
        const n = this._currNode;
        if (n instanceof N1 || N2 && n instanceof N2) {
          this._nodes.pop();
          return this;
        }
        throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
      }
      _elseNode(node) {
        const n = this._currNode;
        if (!(n instanceof If)) {
          throw new Error('CodeGen: "else" without "if"');
        }
        this._currNode = n.else = node;
        return this;
      }
      get _root() {
        return this._nodes[0];
      }
      get _currNode() {
        const ns = this._nodes;
        return ns[ns.length - 1];
      }
      set _currNode(node) {
        const ns = this._nodes;
        ns[ns.length - 1] = node;
      }
    };
    exports.CodeGen = CodeGen;
    function addNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) + (from[n] || 0);
      return names;
    }
    function addExprNames(names, from) {
      return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
    }
    function optimizeExpr(expr, names, constants) {
      if (expr instanceof code_1.Name)
        return replaceName(expr);
      if (!canOptimize(expr))
        return expr;
      return new code_1._Code(expr._items.reduce((items, c) => {
        if (c instanceof code_1.Name)
          c = replaceName(c);
        if (c instanceof code_1._Code)
          items.push(...c._items);
        else
          items.push(c);
        return items;
      }, []));
      function replaceName(n) {
        const c = constants[n.str];
        if (c === void 0 || names[n.str] !== 1)
          return n;
        delete names[n.str];
        return c;
      }
      function canOptimize(e) {
        return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
      }
    }
    function subtractNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) - (from[n] || 0);
    }
    function not(x) {
      return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
    }
    exports.not = not;
    var andCode = mappend(exports.operators.AND);
    function and(...args) {
      return args.reduce(andCode);
    }
    exports.and = and;
    var orCode = mappend(exports.operators.OR);
    function or(...args) {
      return args.reduce(orCode);
    }
    exports.or = or;
    function mappend(op) {
      return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
    }
    function par(x) {
      return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
    }
  }
});

// node_modules/ajv/dist/compile/util.js
var require_util = __commonJS({
  "node_modules/ajv/dist/compile/util.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
    var codegen_1 = require_codegen();
    var code_1 = require_code();
    function toHash(arr) {
      const hash = {};
      for (const item of arr)
        hash[item] = true;
      return hash;
    }
    exports.toHash = toHash;
    function alwaysValidSchema(it, schema) {
      if (typeof schema == "boolean")
        return schema;
      if (Object.keys(schema).length === 0)
        return true;
      checkUnknownRules(it, schema);
      return !schemaHasRules(schema, it.self.RULES.all);
    }
    exports.alwaysValidSchema = alwaysValidSchema;
    function checkUnknownRules(it, schema = it.schema) {
      const { opts, self } = it;
      if (!opts.strictSchema)
        return;
      if (typeof schema === "boolean")
        return;
      const rules = self.RULES.keywords;
      for (const key in schema) {
        if (!rules[key])
          checkStrictMode(it, `unknown keyword: "${key}"`);
      }
    }
    exports.checkUnknownRules = checkUnknownRules;
    function schemaHasRules(schema, rules) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (rules[key])
          return true;
      return false;
    }
    exports.schemaHasRules = schemaHasRules;
    function schemaHasRulesButRef(schema, RULES) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (key !== "$ref" && RULES.all[key])
          return true;
      return false;
    }
    exports.schemaHasRulesButRef = schemaHasRulesButRef;
    function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
      if (!$data) {
        if (typeof schema == "number" || typeof schema == "boolean")
          return schema;
        if (typeof schema == "string")
          return (0, codegen_1._)`${schema}`;
      }
      return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
    }
    exports.schemaRefOrVal = schemaRefOrVal;
    function unescapeFragment(str) {
      return unescapeJsonPointer(decodeURIComponent(str));
    }
    exports.unescapeFragment = unescapeFragment;
    function escapeFragment(str) {
      return encodeURIComponent(escapeJsonPointer(str));
    }
    exports.escapeFragment = escapeFragment;
    function escapeJsonPointer(str) {
      if (typeof str == "number")
        return `${str}`;
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    exports.escapeJsonPointer = escapeJsonPointer;
    function unescapeJsonPointer(str) {
      return str.replace(/~1/g, "/").replace(/~0/g, "~");
    }
    exports.unescapeJsonPointer = unescapeJsonPointer;
    function eachItem(xs, f) {
      if (Array.isArray(xs)) {
        for (const x of xs)
          f(x);
      } else {
        f(xs);
      }
    }
    exports.eachItem = eachItem;
    function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues: mergeValues2, resultToName }) {
      return (gen, from, to, toName) => {
        const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues2(from, to);
        return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
      };
    }
    exports.mergeEvaluated = {
      props: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
          gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
        }),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
          if (from === true) {
            gen.assign(to, true);
          } else {
            gen.assign(to, (0, codegen_1._)`${to} || {}`);
            setEvaluated(gen, to, from);
          }
        }),
        mergeValues: (from, to) => from === true ? true : { ...from, ...to },
        resultToName: evaluatedPropsToName
      }),
      items: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
        mergeValues: (from, to) => from === true ? true : Math.max(from, to),
        resultToName: (gen, items) => gen.var("items", items)
      })
    };
    function evaluatedPropsToName(gen, ps) {
      if (ps === true)
        return gen.var("props", true);
      const props = gen.var("props", (0, codegen_1._)`{}`);
      if (ps !== void 0)
        setEvaluated(gen, props, ps);
      return props;
    }
    exports.evaluatedPropsToName = evaluatedPropsToName;
    function setEvaluated(gen, props, ps) {
      Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
    }
    exports.setEvaluated = setEvaluated;
    var snippets = {};
    function useFunc(gen, f) {
      return gen.scopeValue("func", {
        ref: f,
        code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
      });
    }
    exports.useFunc = useFunc;
    var Type;
    (function(Type2) {
      Type2[Type2["Num"] = 0] = "Num";
      Type2[Type2["Str"] = 1] = "Str";
    })(Type || (exports.Type = Type = {}));
    function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
      if (dataProp instanceof codegen_1.Name) {
        const isNumber = dataPropType === Type.Num;
        return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
      }
      return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
    }
    exports.getErrorPath = getErrorPath;
    function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
      if (!mode)
        return;
      msg = `strict mode: ${msg}`;
      if (mode === true)
        throw new Error(msg);
      it.self.logger.warn(msg);
    }
    exports.checkStrictMode = checkStrictMode;
  }
});

// node_modules/ajv/dist/compile/names.js
var require_names = __commonJS({
  "node_modules/ajv/dist/compile/names.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var names = {
      // validation function arguments
      data: new codegen_1.Name("data"),
      // data passed to validation function
      // args passed from referencing schema
      valCxt: new codegen_1.Name("valCxt"),
      // validation/data context - should not be used directly, it is destructured to the names below
      instancePath: new codegen_1.Name("instancePath"),
      parentData: new codegen_1.Name("parentData"),
      parentDataProperty: new codegen_1.Name("parentDataProperty"),
      rootData: new codegen_1.Name("rootData"),
      // root data - same as the data passed to the first/top validation function
      dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
      // used to support recursiveRef and dynamicRef
      // function scoped variables
      vErrors: new codegen_1.Name("vErrors"),
      // null or array of validation errors
      errors: new codegen_1.Name("errors"),
      // counter of validation errors
      this: new codegen_1.Name("this"),
      // "globals"
      self: new codegen_1.Name("self"),
      scope: new codegen_1.Name("scope"),
      // JTD serialize/parse name for JSON string and position
      json: new codegen_1.Name("json"),
      jsonPos: new codegen_1.Name("jsonPos"),
      jsonLen: new codegen_1.Name("jsonLen"),
      jsonPart: new codegen_1.Name("jsonPart")
    };
    exports.default = names;
  }
});

// node_modules/ajv/dist/compile/errors.js
var require_errors = __commonJS({
  "node_modules/ajv/dist/compile/errors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    exports.keywordError = {
      message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
    };
    exports.keyword$DataError = {
      message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
    };
    function reportError(cxt, error2 = exports.keywordError, errorPaths, overrideAllErrors) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error2, errorPaths);
      if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) {
        addError(gen, errObj);
      } else {
        returnErrors(it, (0, codegen_1._)`[${errObj}]`);
      }
    }
    exports.reportError = reportError;
    function reportExtraError(cxt, error2 = exports.keywordError, errorPaths) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error2, errorPaths);
      addError(gen, errObj);
      if (!(compositeRule || allErrors)) {
        returnErrors(it, names_1.default.vErrors);
      }
    }
    exports.reportExtraError = reportExtraError;
    function resetErrorsCount(gen, errsCount) {
      gen.assign(names_1.default.errors, errsCount);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
    }
    exports.resetErrorsCount = resetErrorsCount;
    function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
      if (errsCount === void 0)
        throw new Error("ajv implementation error");
      const err = gen.name("err");
      gen.forRange("i", errsCount, names_1.default.errors, (i) => {
        gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
        gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
        gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
        if (it.opts.verbose) {
          gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
          gen.assign((0, codegen_1._)`${err}.data`, data);
        }
      });
    }
    exports.extendErrors = extendErrors;
    function addError(gen, errObj) {
      const err = gen.const("err", errObj);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
      gen.code((0, codegen_1._)`${names_1.default.errors}++`);
    }
    function returnErrors(it, errs) {
      const { gen, validateName, schemaEnv } = it;
      if (schemaEnv.$async) {
        gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
        gen.return(false);
      }
    }
    var E = {
      keyword: new codegen_1.Name("keyword"),
      schemaPath: new codegen_1.Name("schemaPath"),
      // also used in JTD errors
      params: new codegen_1.Name("params"),
      propertyName: new codegen_1.Name("propertyName"),
      message: new codegen_1.Name("message"),
      schema: new codegen_1.Name("schema"),
      parentSchema: new codegen_1.Name("parentSchema")
    };
    function errorObjectCode(cxt, error2, errorPaths) {
      const { createErrors } = cxt.it;
      if (createErrors === false)
        return (0, codegen_1._)`{}`;
      return errorObject(cxt, error2, errorPaths);
    }
    function errorObject(cxt, error2, errorPaths = {}) {
      const { gen, it } = cxt;
      const keyValues = [
        errorInstancePath(it, errorPaths),
        errorSchemaPath(cxt, errorPaths)
      ];
      extraErrorProps(cxt, error2, keyValues);
      return gen.object(...keyValues);
    }
    function errorInstancePath({ errorPath }, { instancePath }) {
      const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
      return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
    }
    function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
      let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
      if (schemaPath) {
        schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
      }
      return [E.schemaPath, schPath];
    }
    function extraErrorProps(cxt, { params, message }, keyValues) {
      const { keyword, data, schemaValue, it } = cxt;
      const { opts, propertyName, topSchemaRef, schemaPath } = it;
      keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
      if (opts.messages) {
        keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
      }
      if (opts.verbose) {
        keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
      }
      if (propertyName)
        keyValues.push([E.propertyName, propertyName]);
    }
  }
});

// node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS({
  "node_modules/ajv/dist/compile/validate/boolSchema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var boolError = {
      message: "boolean schema is false"
    };
    function topBoolOrEmptySchema(it) {
      const { gen, schema, validateName } = it;
      if (schema === false) {
        falseSchemaError(it, false);
      } else if (typeof schema == "object" && schema.$async === true) {
        gen.return(names_1.default.data);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, null);
        gen.return(true);
      }
    }
    exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
    function boolOrEmptySchema(it, valid) {
      const { gen, schema } = it;
      if (schema === false) {
        gen.var(valid, false);
        falseSchemaError(it);
      } else {
        gen.var(valid, true);
      }
    }
    exports.boolOrEmptySchema = boolOrEmptySchema;
    function falseSchemaError(it, overrideAllErrors) {
      const { gen, data } = it;
      const cxt = {
        gen,
        keyword: "false schema",
        data,
        schema: false,
        schemaCode: false,
        schemaValue: false,
        params: {},
        it
      };
      (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
    }
  }
});

// node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS({
  "node_modules/ajv/dist/compile/rules.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getRules = exports.isJSONType = void 0;
    var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
    var jsonTypes = new Set(_jsonTypes);
    function isJSONType(x) {
      return typeof x == "string" && jsonTypes.has(x);
    }
    exports.isJSONType = isJSONType;
    function getRules() {
      const groups = {
        number: { type: "number", rules: [] },
        string: { type: "string", rules: [] },
        array: { type: "array", rules: [] },
        object: { type: "object", rules: [] }
      };
      return {
        types: { ...groups, integer: true, boolean: true, null: true },
        rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
        post: { rules: [] },
        all: {},
        keywords: {}
      };
    }
    exports.getRules = getRules;
  }
});

// node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS({
  "node_modules/ajv/dist/compile/validate/applicability.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
    function schemaHasRulesForType({ schema, self }, type) {
      const group = self.RULES.types[type];
      return group && group !== true && shouldUseGroup(schema, group);
    }
    exports.schemaHasRulesForType = schemaHasRulesForType;
    function shouldUseGroup(schema, group) {
      return group.rules.some((rule) => shouldUseRule(schema, rule));
    }
    exports.shouldUseGroup = shouldUseGroup;
    function shouldUseRule(schema, rule) {
      var _a3;
      return schema[rule.keyword] !== void 0 || ((_a3 = rule.definition.implements) === null || _a3 === void 0 ? void 0 : _a3.some((kwd) => schema[kwd] !== void 0));
    }
    exports.shouldUseRule = shouldUseRule;
  }
});

// node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS({
  "node_modules/ajv/dist/compile/validate/dataType.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
    var rules_1 = require_rules();
    var applicability_1 = require_applicability();
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Correct"] = 0] = "Correct";
      DataType2[DataType2["Wrong"] = 1] = "Wrong";
    })(DataType || (exports.DataType = DataType = {}));
    function getSchemaTypes(schema) {
      const types = getJSONTypes(schema.type);
      const hasNull = types.includes("null");
      if (hasNull) {
        if (schema.nullable === false)
          throw new Error("type: null contradicts nullable: false");
      } else {
        if (!types.length && schema.nullable !== void 0) {
          throw new Error('"nullable" cannot be used without "type"');
        }
        if (schema.nullable === true)
          types.push("null");
      }
      return types;
    }
    exports.getSchemaTypes = getSchemaTypes;
    function getJSONTypes(ts) {
      const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
      if (types.every(rules_1.isJSONType))
        return types;
      throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
    }
    exports.getJSONTypes = getJSONTypes;
    function coerceAndCheckDataType(it, types) {
      const { gen, data, opts } = it;
      const coerceTo = coerceToTypes(types, opts.coerceTypes);
      const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
      if (checkTypes) {
        const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
        gen.if(wrongType, () => {
          if (coerceTo.length)
            coerceData(it, types, coerceTo);
          else
            reportTypeError(it);
        });
      }
      return checkTypes;
    }
    exports.coerceAndCheckDataType = coerceAndCheckDataType;
    var COERCIBLE = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
    function coerceToTypes(types, coerceTypes) {
      return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
    }
    function coerceData(it, types, coerceTo) {
      const { gen, data, opts } = it;
      const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
      const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
      if (opts.coerceTypes === "array") {
        gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
      }
      gen.if((0, codegen_1._)`${coerced} !== undefined`);
      for (const t of coerceTo) {
        if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
          coerceSpecificType(t);
        }
      }
      gen.else();
      reportTypeError(it);
      gen.endIf();
      gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
        gen.assign(data, coerced);
        assignParentData(it, coerced);
      });
      function coerceSpecificType(t) {
        switch (t) {
          case "string":
            gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
            return;
          case "number":
            gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "integer":
            gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "boolean":
            gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
            return;
          case "null":
            gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
            gen.assign(coerced, null);
            return;
          case "array":
            gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
        }
      }
    }
    function assignParentData({ gen, parentData, parentDataProperty }, expr) {
      gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
    }
    function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
      const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
      let cond;
      switch (dataType) {
        case "null":
          return (0, codegen_1._)`${data} ${EQ} null`;
        case "array":
          cond = (0, codegen_1._)`Array.isArray(${data})`;
          break;
        case "object":
          cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
          break;
        case "integer":
          cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
          break;
        case "number":
          cond = numCond();
          break;
        default:
          return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
      }
      return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
      function numCond(_cond = codegen_1.nil) {
        return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
      }
    }
    exports.checkDataType = checkDataType;
    function checkDataTypes(dataTypes, data, strictNums, correct) {
      if (dataTypes.length === 1) {
        return checkDataType(dataTypes[0], data, strictNums, correct);
      }
      let cond;
      const types = (0, util_1.toHash)(dataTypes);
      if (types.array && types.object) {
        const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
        cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
        delete types.null;
        delete types.array;
        delete types.object;
      } else {
        cond = codegen_1.nil;
      }
      if (types.number)
        delete types.integer;
      for (const t in types)
        cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
      return cond;
    }
    exports.checkDataTypes = checkDataTypes;
    var typeError = {
      message: ({ schema }) => `must be ${schema}`,
      params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
    };
    function reportTypeError(it) {
      const cxt = getTypeErrorContext(it);
      (0, errors_1.reportError)(cxt, typeError);
    }
    exports.reportTypeError = reportTypeError;
    function getTypeErrorContext(it) {
      const { gen, data, schema } = it;
      const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
      return {
        gen,
        keyword: "type",
        data,
        schema: schema.type,
        schemaCode,
        schemaValue: schemaCode,
        parentSchema: schema,
        params: {},
        it
      };
    }
  }
});

// node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS({
  "node_modules/ajv/dist/compile/validate/defaults.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.assignDefaults = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function assignDefaults(it, ty) {
      const { properties, items } = it.schema;
      if (ty === "object" && properties) {
        for (const key in properties) {
          assignDefault(it, key, properties[key].default);
        }
      } else if (ty === "array" && Array.isArray(items)) {
        items.forEach((sch, i) => assignDefault(it, i, sch.default));
      }
    }
    exports.assignDefaults = assignDefaults;
    function assignDefault(it, prop, defaultValue) {
      const { gen, compositeRule, data, opts } = it;
      if (defaultValue === void 0)
        return;
      const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
      if (compositeRule) {
        (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
        return;
      }
      let condition = (0, codegen_1._)`${childData} === undefined`;
      if (opts.useDefaults === "empty") {
        condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
      }
      gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
    }
  }
});

// node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var util_2 = require_util();
    function checkReportMissingProp(cxt, prop) {
      const { gen, data, it } = cxt;
      gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
        cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
        cxt.error();
      });
    }
    exports.checkReportMissingProp = checkReportMissingProp;
    function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
      return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
    }
    exports.checkMissingProp = checkMissingProp;
    function reportMissingProp(cxt, missing) {
      cxt.setParams({ missingProperty: missing }, true);
      cxt.error();
    }
    exports.reportMissingProp = reportMissingProp;
    function hasPropFunc(gen) {
      return gen.scopeValue("func", {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        ref: Object.prototype.hasOwnProperty,
        code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
      });
    }
    exports.hasPropFunc = hasPropFunc;
    function isOwnProperty(gen, data, property) {
      return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
    }
    exports.isOwnProperty = isOwnProperty;
    function propertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
      return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
    }
    exports.propertyInData = propertyInData;
    function noPropertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
      return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
    }
    exports.noPropertyInData = noPropertyInData;
    function allSchemaProperties(schemaMap) {
      return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
    }
    exports.allSchemaProperties = allSchemaProperties;
    function schemaProperties(it, schemaMap) {
      return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
    }
    exports.schemaProperties = schemaProperties;
    function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
      const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
      const valCxt = [
        [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
        [names_1.default.parentData, it.parentData],
        [names_1.default.parentDataProperty, it.parentDataProperty],
        [names_1.default.rootData, names_1.default.rootData]
      ];
      if (it.opts.dynamicRef)
        valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
      const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
      return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
    }
    exports.callValidateCode = callValidateCode;
    var newRegExp = (0, codegen_1._)`new RegExp`;
    function usePattern({ gen, it: { opts } }, pattern) {
      const u = opts.unicodeRegExp ? "u" : "";
      const { regExp } = opts.code;
      const rx = regExp(pattern, u);
      return gen.scopeValue("pattern", {
        key: rx.toString(),
        ref: rx,
        code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
      });
    }
    exports.usePattern = usePattern;
    function validateArray(cxt) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      if (it.allErrors) {
        const validArr = gen.let("valid", true);
        validateItems(() => gen.assign(validArr, false));
        return validArr;
      }
      gen.var(valid, true);
      validateItems(() => gen.break());
      return valid;
      function validateItems(notValid) {
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword,
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          gen.if((0, codegen_1.not)(valid), notValid);
        });
      }
    }
    exports.validateArray = validateArray;
    function validateUnion(cxt) {
      const { gen, schema, keyword, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
      if (alwaysValid && !it.opts.unevaluated)
        return;
      const valid = gen.let("valid", false);
      const schValid = gen.name("_valid");
      gen.block(() => schema.forEach((_sch, i) => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: i,
          compositeRule: true
        }, schValid);
        gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
        const merged = cxt.mergeValidEvaluated(schCxt, schValid);
        if (!merged)
          gen.if((0, codegen_1.not)(valid));
      }));
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    }
    exports.validateUnion = validateUnion;
  }
});

// node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS({
  "node_modules/ajv/dist/compile/validate/keyword.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var code_1 = require_code2();
    var errors_1 = require_errors();
    function macroKeywordCode(cxt, def) {
      const { gen, keyword, schema, parentSchema, it } = cxt;
      const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
      const schemaRef = useKeyword(gen, keyword, macroSchema);
      if (it.opts.validateSchema !== false)
        it.self.validateSchema(macroSchema, true);
      const valid = gen.name("valid");
      cxt.subschema({
        schema: macroSchema,
        schemaPath: codegen_1.nil,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`,
        topSchemaRef: schemaRef,
        compositeRule: true
      }, valid);
      cxt.pass(valid, () => cxt.error(true));
    }
    exports.macroKeywordCode = macroKeywordCode;
    function funcKeywordCode(cxt, def) {
      var _a3;
      const { gen, keyword, schema, parentSchema, $data, it } = cxt;
      checkAsyncKeyword(it, def);
      const validate = !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate;
      const validateRef = useKeyword(gen, keyword, validate);
      const valid = gen.let("valid");
      cxt.block$data(valid, validateKeyword);
      cxt.ok((_a3 = def.valid) !== null && _a3 !== void 0 ? _a3 : valid);
      function validateKeyword() {
        if (def.errors === false) {
          assignValid();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => cxt.error());
        } else {
          const ruleErrs = def.async ? validateAsync() : validateSync();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => addErrs(cxt, ruleErrs));
        }
      }
      function validateAsync() {
        const ruleErrs = gen.let("ruleErrs", null);
        gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
        return ruleErrs;
      }
      function validateSync() {
        const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
        gen.assign(validateErrs, null);
        assignValid(codegen_1.nil);
        return validateErrs;
      }
      function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
        const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
        const passSchema = !("compile" in def && !$data || def.schema === false);
        gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
      }
      function reportErrs(errors) {
        var _a4;
        gen.if((0, codegen_1.not)((_a4 = def.valid) !== null && _a4 !== void 0 ? _a4 : valid), errors);
      }
    }
    exports.funcKeywordCode = funcKeywordCode;
    function modifyData(cxt) {
      const { gen, data, it } = cxt;
      gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
    }
    function addErrs(cxt, errs) {
      const { gen } = cxt;
      gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
        (0, errors_1.extendErrors)(cxt);
      }, () => cxt.error());
    }
    function checkAsyncKeyword({ schemaEnv }, def) {
      if (def.async && !schemaEnv.$async)
        throw new Error("async keyword in sync schema");
    }
    function useKeyword(gen, keyword, result) {
      if (result === void 0)
        throw new Error(`keyword "${keyword}" failed to compile`);
      return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
    }
    function validSchemaType(schema, schemaType, allowUndefined = false) {
      return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
    }
    exports.validSchemaType = validSchemaType;
    function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
      if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) {
        throw new Error("ajv implementation error");
      }
      const deps = def.dependencies;
      if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
        throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
      }
      if (def.validateSchema) {
        const valid = def.validateSchema(schema[keyword]);
        if (!valid) {
          const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
          if (opts.validateSchema === "log")
            self.logger.error(msg);
          else
            throw new Error(msg);
        }
      }
    }
    exports.validateKeywordUsage = validateKeywordUsage;
  }
});

// node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS({
  "node_modules/ajv/dist/compile/validate/subschema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
      if (keyword !== void 0 && schema !== void 0) {
        throw new Error('both "keyword" and "schema" passed, only one allowed');
      }
      if (keyword !== void 0) {
        const sch = it.schema[keyword];
        return schemaProp === void 0 ? {
          schema: sch,
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}`
        } : {
          schema: sch[schemaProp],
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
        };
      }
      if (schema !== void 0) {
        if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) {
          throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
        }
        return {
          schema,
          schemaPath,
          topSchemaRef,
          errSchemaPath
        };
      }
      throw new Error('either "keyword" or "schema" must be passed');
    }
    exports.getSubschema = getSubschema;
    function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
      if (data !== void 0 && dataProp !== void 0) {
        throw new Error('both "data" and "dataProp" passed, only one allowed');
      }
      const { gen } = it;
      if (dataProp !== void 0) {
        const { errorPath, dataPathArr, opts } = it;
        const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
        dataContextProps(nextData);
        subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
        subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
        subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
      }
      if (data !== void 0) {
        const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
        dataContextProps(nextData);
        if (propertyName !== void 0)
          subschema.propertyName = propertyName;
      }
      if (dataTypes)
        subschema.dataTypes = dataTypes;
      function dataContextProps(_nextData) {
        subschema.data = _nextData;
        subschema.dataLevel = it.dataLevel + 1;
        subschema.dataTypes = [];
        it.definedProperties = /* @__PURE__ */ new Set();
        subschema.parentData = it.data;
        subschema.dataNames = [...it.dataNames, _nextData];
      }
    }
    exports.extendSubschemaData = extendSubschemaData;
    function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
      if (compositeRule !== void 0)
        subschema.compositeRule = compositeRule;
      if (createErrors !== void 0)
        subschema.createErrors = createErrors;
      if (allErrors !== void 0)
        subschema.allErrors = allErrors;
      subschema.jtdDiscriminator = jtdDiscriminator;
      subschema.jtdMetadata = jtdMetadata;
    }
    exports.extendSubschemaMode = extendSubschemaMode;
  }
});

// node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "node_modules/fast-deep-equal/index.js"(exports, module) {
    "use strict";
    module.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS({
  "node_modules/json-schema-traverse/index.js"(exports, module) {
    "use strict";
    var traverse = module.exports = function(schema, opts, cb) {
      if (typeof opts == "function") {
        cb = opts;
        opts = {};
      }
      cb = opts.cb || cb;
      var pre = typeof cb == "function" ? cb : cb.pre || function() {
      };
      var post = cb.post || function() {
      };
      _traverse(opts, pre, post, schema, "", schema);
    };
    traverse.keywords = {
      additionalItems: true,
      items: true,
      contains: true,
      additionalProperties: true,
      propertyNames: true,
      not: true,
      if: true,
      then: true,
      else: true
    };
    traverse.arrayKeywords = {
      items: true,
      allOf: true,
      anyOf: true,
      oneOf: true
    };
    traverse.propsKeywords = {
      $defs: true,
      definitions: true,
      properties: true,
      patternProperties: true,
      dependencies: true
    };
    traverse.skipKeywords = {
      default: true,
      enum: true,
      const: true,
      required: true,
      maximum: true,
      minimum: true,
      exclusiveMaximum: true,
      exclusiveMinimum: true,
      multipleOf: true,
      maxLength: true,
      minLength: true,
      pattern: true,
      format: true,
      maxItems: true,
      minItems: true,
      uniqueItems: true,
      maxProperties: true,
      minProperties: true
    };
    function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
      if (schema && typeof schema == "object" && !Array.isArray(schema)) {
        pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
        for (var key in schema) {
          var sch = schema[key];
          if (Array.isArray(sch)) {
            if (key in traverse.arrayKeywords) {
              for (var i = 0; i < sch.length; i++)
                _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
            }
          } else if (key in traverse.propsKeywords) {
            if (sch && typeof sch == "object") {
              for (var prop in sch)
                _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
            }
          } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
            _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
          }
        }
        post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      }
    }
    function escapeJsonPtr(str) {
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
  }
});

// node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS({
  "node_modules/ajv/dist/compile/resolve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
    var util_1 = require_util();
    var equal = require_fast_deep_equal();
    var traverse = require_json_schema_traverse();
    var SIMPLE_INLINED = /* @__PURE__ */ new Set([
      "type",
      "format",
      "pattern",
      "maxLength",
      "minLength",
      "maxProperties",
      "minProperties",
      "maxItems",
      "minItems",
      "maximum",
      "minimum",
      "uniqueItems",
      "multipleOf",
      "required",
      "enum",
      "const"
    ]);
    function inlineRef(schema, limit = true) {
      if (typeof schema == "boolean")
        return true;
      if (limit === true)
        return !hasRef(schema);
      if (!limit)
        return false;
      return countKeys(schema) <= limit;
    }
    exports.inlineRef = inlineRef;
    var REF_KEYWORDS = /* @__PURE__ */ new Set([
      "$ref",
      "$recursiveRef",
      "$recursiveAnchor",
      "$dynamicRef",
      "$dynamicAnchor"
    ]);
    function hasRef(schema) {
      for (const key in schema) {
        if (REF_KEYWORDS.has(key))
          return true;
        const sch = schema[key];
        if (Array.isArray(sch) && sch.some(hasRef))
          return true;
        if (typeof sch == "object" && hasRef(sch))
          return true;
      }
      return false;
    }
    function countKeys(schema) {
      let count3 = 0;
      for (const key in schema) {
        if (key === "$ref")
          return Infinity;
        count3++;
        if (SIMPLE_INLINED.has(key))
          continue;
        if (typeof schema[key] == "object") {
          (0, util_1.eachItem)(schema[key], (sch) => count3 += countKeys(sch));
        }
        if (count3 === Infinity)
          return Infinity;
      }
      return count3;
    }
    function getFullPath(resolver, id = "", normalize) {
      if (normalize !== false)
        id = normalizeId(id);
      const p = resolver.parse(id);
      return _getFullPath(resolver, p);
    }
    exports.getFullPath = getFullPath;
    function _getFullPath(resolver, p) {
      const serialized = resolver.serialize(p);
      return serialized.split("#")[0] + "#";
    }
    exports._getFullPath = _getFullPath;
    var TRAILING_SLASH_HASH = /#\/?$/;
    function normalizeId(id) {
      return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
    }
    exports.normalizeId = normalizeId;
    function resolveUrl(resolver, baseId, id) {
      id = normalizeId(id);
      return resolver.resolve(baseId, id);
    }
    exports.resolveUrl = resolveUrl;
    var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
    function getSchemaRefs(schema, baseId) {
      if (typeof schema == "boolean")
        return {};
      const { schemaId, uriResolver } = this.opts;
      const schId = normalizeId(schema[schemaId] || baseId);
      const baseIds = { "": schId };
      const pathPrefix = getFullPath(uriResolver, schId, false);
      const localRefs = {};
      const schemaRefs = /* @__PURE__ */ new Set();
      traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
        if (parentJsonPtr === void 0)
          return;
        const fullPath = pathPrefix + jsonPtr;
        let innerBaseId = baseIds[parentJsonPtr];
        if (typeof sch[schemaId] == "string")
          innerBaseId = addRef.call(this, sch[schemaId]);
        addAnchor.call(this, sch.$anchor);
        addAnchor.call(this, sch.$dynamicAnchor);
        baseIds[jsonPtr] = innerBaseId;
        function addRef(ref) {
          const _resolve = this.opts.uriResolver.resolve;
          ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
          if (schemaRefs.has(ref))
            throw ambiguos(ref);
          schemaRefs.add(ref);
          let schOrRef = this.refs[ref];
          if (typeof schOrRef == "string")
            schOrRef = this.refs[schOrRef];
          if (typeof schOrRef == "object") {
            checkAmbiguosRef(sch, schOrRef.schema, ref);
          } else if (ref !== normalizeId(fullPath)) {
            if (ref[0] === "#") {
              checkAmbiguosRef(sch, localRefs[ref], ref);
              localRefs[ref] = sch;
            } else {
              this.refs[ref] = fullPath;
            }
          }
          return ref;
        }
        function addAnchor(anchor) {
          if (typeof anchor == "string") {
            if (!ANCHOR.test(anchor))
              throw new Error(`invalid anchor "${anchor}"`);
            addRef.call(this, `#${anchor}`);
          }
        }
      });
      return localRefs;
      function checkAmbiguosRef(sch1, sch2, ref) {
        if (sch2 !== void 0 && !equal(sch1, sch2))
          throw ambiguos(ref);
      }
      function ambiguos(ref) {
        return new Error(`reference "${ref}" resolves to more than one schema`);
      }
    }
    exports.getSchemaRefs = getSchemaRefs;
  }
});

// node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS({
  "node_modules/ajv/dist/compile/validate/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
    var boolSchema_1 = require_boolSchema();
    var dataType_1 = require_dataType();
    var applicability_1 = require_applicability();
    var dataType_2 = require_dataType();
    var defaults_1 = require_defaults();
    var keyword_1 = require_keyword();
    var subschema_1 = require_subschema();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var errors_1 = require_errors();
    function validateFunctionCode(it) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          topSchemaObjCode(it);
          return;
        }
      }
      validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
    }
    exports.validateFunctionCode = validateFunctionCode;
    function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
      if (opts.code.es5) {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
          gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
          destructureValCxtES5(gen, opts);
          gen.code(body);
        });
      } else {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
      }
    }
    function destructureValCxt(opts) {
      return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
    }
    function destructureValCxtES5(gen, opts) {
      gen.if(names_1.default.valCxt, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
        gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
      }, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.rootData, names_1.default.data);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
      });
    }
    function topSchemaObjCode(it) {
      const { schema, opts, gen } = it;
      validateFunction(it, () => {
        if (opts.$comment && schema.$comment)
          commentKeyword(it);
        checkNoDefault(it);
        gen.let(names_1.default.vErrors, null);
        gen.let(names_1.default.errors, 0);
        if (opts.unevaluated)
          resetEvaluated(it);
        typeAndKeywords(it);
        returnResults(it);
      });
      return;
    }
    function resetEvaluated(it) {
      const { gen, validateName } = it;
      it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
    }
    function funcSourceUrl(schema, opts) {
      const schId = typeof schema == "object" && schema[opts.schemaId];
      return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
    }
    function subschemaCode(it, valid) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          subSchemaObjCode(it, valid);
          return;
        }
      }
      (0, boolSchema_1.boolOrEmptySchema)(it, valid);
    }
    function schemaCxtHasRules({ schema, self }) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (self.RULES.all[key])
          return true;
      return false;
    }
    function isSchemaObj(it) {
      return typeof it.schema != "boolean";
    }
    function subSchemaObjCode(it, valid) {
      const { schema, gen, opts } = it;
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      updateContext(it);
      checkAsyncSchema(it);
      const errsCount = gen.const("_errs", names_1.default.errors);
      typeAndKeywords(it, errsCount);
      gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
    }
    function checkKeywords(it) {
      (0, util_1.checkUnknownRules)(it);
      checkRefsAndKeywords(it);
    }
    function typeAndKeywords(it, errsCount) {
      if (it.opts.jtd)
        return schemaKeywords(it, [], false, errsCount);
      const types = (0, dataType_1.getSchemaTypes)(it.schema);
      const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
      schemaKeywords(it, types, !checkedTypes, errsCount);
    }
    function checkRefsAndKeywords(it) {
      const { schema, errSchemaPath, opts, self } = it;
      if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
        self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
      }
    }
    function checkNoDefault(it) {
      const { schema, opts } = it;
      if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) {
        (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
      }
    }
    function updateContext(it) {
      const schId = it.schema[it.opts.schemaId];
      if (schId)
        it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
    }
    function checkAsyncSchema(it) {
      if (it.schema.$async && !it.schemaEnv.$async)
        throw new Error("async schema in sync schema");
    }
    function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
      const msg = schema.$comment;
      if (opts.$comment === true) {
        gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
      } else if (typeof opts.$comment == "function") {
        const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
        const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
        gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
      }
    }
    function returnResults(it) {
      const { gen, schemaEnv, validateName, ValidationError, opts } = it;
      if (schemaEnv.$async) {
        gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
        if (opts.unevaluated)
          assignEvaluated(it);
        gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
      }
    }
    function assignEvaluated({ gen, evaluated, props, items }) {
      if (props instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.props`, props);
      if (items instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.items`, items);
    }
    function schemaKeywords(it, types, typeErrors, errsCount) {
      const { gen, schema, data, allErrors, opts, self } = it;
      const { RULES } = self;
      if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
        gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
        return;
      }
      if (!opts.jtd)
        checkStrictTypes(it, types);
      gen.block(() => {
        for (const group of RULES.rules)
          groupKeywords(group);
        groupKeywords(RULES.post);
      });
      function groupKeywords(group) {
        if (!(0, applicability_1.shouldUseGroup)(schema, group))
          return;
        if (group.type) {
          gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
          iterateKeywords(it, group);
          if (types.length === 1 && types[0] === group.type && typeErrors) {
            gen.else();
            (0, dataType_2.reportTypeError)(it);
          }
          gen.endIf();
        } else {
          iterateKeywords(it, group);
        }
        if (!allErrors)
          gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
      }
    }
    function iterateKeywords(it, group) {
      const { gen, schema, opts: { useDefaults } } = it;
      if (useDefaults)
        (0, defaults_1.assignDefaults)(it, group.type);
      gen.block(() => {
        for (const rule of group.rules) {
          if ((0, applicability_1.shouldUseRule)(schema, rule)) {
            keywordCode(it, rule.keyword, rule.definition, group.type);
          }
        }
      });
    }
    function checkStrictTypes(it, types) {
      if (it.schemaEnv.meta || !it.opts.strictTypes)
        return;
      checkContextTypes(it, types);
      if (!it.opts.allowUnionTypes)
        checkMultipleTypes(it, types);
      checkKeywordTypes(it, it.dataTypes);
    }
    function checkContextTypes(it, types) {
      if (!types.length)
        return;
      if (!it.dataTypes.length) {
        it.dataTypes = types;
        return;
      }
      types.forEach((t) => {
        if (!includesType(it.dataTypes, t)) {
          strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
        }
      });
      narrowSchemaTypes(it, types);
    }
    function checkMultipleTypes(it, ts) {
      if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
        strictTypesError(it, "use allowUnionTypes to allow union type keyword");
      }
    }
    function checkKeywordTypes(it, ts) {
      const rules = it.self.RULES.all;
      for (const keyword in rules) {
        const rule = rules[keyword];
        if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
          const { type } = rule.definition;
          if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
            strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
          }
        }
      }
    }
    function hasApplicableType(schTs, kwdT) {
      return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
    }
    function includesType(ts, t) {
      return ts.includes(t) || t === "integer" && ts.includes("number");
    }
    function narrowSchemaTypes(it, withTypes) {
      const ts = [];
      for (const t of it.dataTypes) {
        if (includesType(withTypes, t))
          ts.push(t);
        else if (withTypes.includes("integer") && t === "number")
          ts.push("integer");
      }
      it.dataTypes = ts;
    }
    function strictTypesError(it, msg) {
      const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
      msg += ` at "${schemaPath}" (strictTypes)`;
      (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
    }
    var KeywordCxt = class {
      constructor(it, def, keyword) {
        (0, keyword_1.validateKeywordUsage)(it, def, keyword);
        this.gen = it.gen;
        this.allErrors = it.allErrors;
        this.keyword = keyword;
        this.data = it.data;
        this.schema = it.schema[keyword];
        this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
        this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
        this.schemaType = def.schemaType;
        this.parentSchema = it.schema;
        this.params = {};
        this.it = it;
        this.def = def;
        if (this.$data) {
          this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
        } else {
          this.schemaCode = this.schemaValue;
          if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) {
            throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
          }
        }
        if ("code" in def ? def.trackErrors : def.errors !== false) {
          this.errsCount = it.gen.const("_errs", names_1.default.errors);
        }
      }
      result(condition, successAction, failAction) {
        this.failResult((0, codegen_1.not)(condition), successAction, failAction);
      }
      failResult(condition, successAction, failAction) {
        this.gen.if(condition);
        if (failAction)
          failAction();
        else
          this.error();
        if (successAction) {
          this.gen.else();
          successAction();
          if (this.allErrors)
            this.gen.endIf();
        } else {
          if (this.allErrors)
            this.gen.endIf();
          else
            this.gen.else();
        }
      }
      pass(condition, failAction) {
        this.failResult((0, codegen_1.not)(condition), void 0, failAction);
      }
      fail(condition) {
        if (condition === void 0) {
          this.error();
          if (!this.allErrors)
            this.gen.if(false);
          return;
        }
        this.gen.if(condition);
        this.error();
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
      fail$data(condition) {
        if (!this.$data)
          return this.fail(condition);
        const { schemaCode } = this;
        this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
      }
      error(append, errorParams, errorPaths) {
        if (errorParams) {
          this.setParams(errorParams);
          this._error(append, errorPaths);
          this.setParams({});
          return;
        }
        this._error(append, errorPaths);
      }
      _error(append, errorPaths) {
        ;
        (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
      }
      $dataError() {
        (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
      }
      reset() {
        if (this.errsCount === void 0)
          throw new Error('add "trackErrors" to keyword definition');
        (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
      }
      ok(cond) {
        if (!this.allErrors)
          this.gen.if(cond);
      }
      setParams(obj, assign) {
        if (assign)
          Object.assign(this.params, obj);
        else
          this.params = obj;
      }
      block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
        this.gen.block(() => {
          this.check$data(valid, $dataValid);
          codeBlock();
        });
      }
      check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
        if (!this.$data)
          return;
        const { gen, schemaCode, schemaType, def } = this;
        gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
        if (valid !== codegen_1.nil)
          gen.assign(valid, true);
        if (schemaType.length || def.validateSchema) {
          gen.elseIf(this.invalid$data());
          this.$dataError();
          if (valid !== codegen_1.nil)
            gen.assign(valid, false);
        }
        gen.else();
      }
      invalid$data() {
        const { gen, schemaCode, schemaType, def, it } = this;
        return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
        function wrong$DataType() {
          if (schemaType.length) {
            if (!(schemaCode instanceof codegen_1.Name))
              throw new Error("ajv implementation error");
            const st = Array.isArray(schemaType) ? schemaType : [schemaType];
            return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
          }
          return codegen_1.nil;
        }
        function invalid$DataSchema() {
          if (def.validateSchema) {
            const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
            return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
          }
          return codegen_1.nil;
        }
      }
      subschema(appl, valid) {
        const subschema = (0, subschema_1.getSubschema)(this.it, appl);
        (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
        (0, subschema_1.extendSubschemaMode)(subschema, appl);
        const nextContext = { ...this.it, ...subschema, items: void 0, props: void 0 };
        subschemaCode(nextContext, valid);
        return nextContext;
      }
      mergeEvaluated(schemaCxt, toName) {
        const { it, gen } = this;
        if (!it.opts.unevaluated)
          return;
        if (it.props !== true && schemaCxt.props !== void 0) {
          it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
        }
        if (it.items !== true && schemaCxt.items !== void 0) {
          it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
        }
      }
      mergeValidEvaluated(schemaCxt, valid) {
        const { it, gen } = this;
        if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
          gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
          return true;
        }
      }
    };
    exports.KeywordCxt = KeywordCxt;
    function keywordCode(it, keyword, def, ruleType) {
      const cxt = new KeywordCxt(it, def, keyword);
      if ("code" in def) {
        def.code(cxt, ruleType);
      } else if (cxt.$data && def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      } else if ("macro" in def) {
        (0, keyword_1.macroKeywordCode)(cxt, def);
      } else if (def.compile || def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      }
    }
    var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
    var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
    function getData($data, { dataLevel, dataNames, dataPathArr }) {
      let jsonPointer;
      let data;
      if ($data === "")
        return names_1.default.rootData;
      if ($data[0] === "/") {
        if (!JSON_POINTER.test($data))
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        jsonPointer = $data;
        data = names_1.default.rootData;
      } else {
        const matches = RELATIVE_JSON_POINTER.exec($data);
        if (!matches)
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        const up = +matches[1];
        jsonPointer = matches[2];
        if (jsonPointer === "#") {
          if (up >= dataLevel)
            throw new Error(errorMsg("property/index", up));
          return dataPathArr[dataLevel - up];
        }
        if (up > dataLevel)
          throw new Error(errorMsg("data", up));
        data = dataNames[dataLevel - up];
        if (!jsonPointer)
          return data;
      }
      let expr = data;
      const segments = jsonPointer.split("/");
      for (const segment of segments) {
        if (segment) {
          data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
          expr = (0, codegen_1._)`${expr} && ${data}`;
        }
      }
      return expr;
      function errorMsg(pointerType, up) {
        return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
      }
    }
    exports.getData = getData;
  }
});

// node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS({
  "node_modules/ajv/dist/runtime/validation_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var ValidationError = class extends Error {
      constructor(errors) {
        super("validation failed");
        this.errors = errors;
        this.ajv = this.validation = true;
      }
    };
    exports.default = ValidationError;
  }
});

// node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS({
  "node_modules/ajv/dist/compile/ref_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var resolve_1 = require_resolve();
    var MissingRefError = class extends Error {
      constructor(resolver, baseId, ref, msg) {
        super(msg || `can't resolve reference ${ref} from id ${baseId}`);
        this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
        this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
      }
    };
    exports.default = MissingRefError;
  }
});

// node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS({
  "node_modules/ajv/dist/compile/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
    var codegen_1 = require_codegen();
    var validation_error_1 = require_validation_error();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var validate_1 = require_validate();
    var SchemaEnv = class {
      constructor(env) {
        var _a3;
        this.refs = {};
        this.dynamicAnchors = {};
        let schema;
        if (typeof env.schema == "object")
          schema = env.schema;
        this.schema = env.schema;
        this.schemaId = env.schemaId;
        this.root = env.root || this;
        this.baseId = (_a3 = env.baseId) !== null && _a3 !== void 0 ? _a3 : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
        this.schemaPath = env.schemaPath;
        this.localRefs = env.localRefs;
        this.meta = env.meta;
        this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
        this.refs = {};
      }
    };
    exports.SchemaEnv = SchemaEnv;
    function compileSchema(sch) {
      const _sch = getCompilingSchema.call(this, sch);
      if (_sch)
        return _sch;
      const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
      const { es5, lines } = this.opts.code;
      const { ownProperties } = this.opts;
      const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
      let _ValidationError;
      if (sch.$async) {
        _ValidationError = gen.scopeValue("Error", {
          ref: validation_error_1.default,
          code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
        });
      }
      const validateName = gen.scopeName("validate");
      sch.validateName = validateName;
      const schemaCxt = {
        gen,
        allErrors: this.opts.allErrors,
        data: names_1.default.data,
        parentData: names_1.default.parentData,
        parentDataProperty: names_1.default.parentDataProperty,
        dataNames: [names_1.default.data],
        dataPathArr: [codegen_1.nil],
        // TODO can its length be used as dataLevel if nil is removed?
        dataLevel: 0,
        dataTypes: [],
        definedProperties: /* @__PURE__ */ new Set(),
        topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
        validateName,
        ValidationError: _ValidationError,
        schema: sch.schema,
        schemaEnv: sch,
        rootId,
        baseId: sch.baseId || rootId,
        schemaPath: codegen_1.nil,
        errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
        errorPath: (0, codegen_1._)`""`,
        opts: this.opts,
        self: this
      };
      let sourceCode;
      try {
        this._compilations.add(sch);
        (0, validate_1.validateFunctionCode)(schemaCxt);
        gen.optimize(this.opts.code.optimize);
        const validateCode = gen.toString();
        sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
        if (this.opts.code.process)
          sourceCode = this.opts.code.process(sourceCode, sch);
        const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
        const validate = makeValidate(this, this.scope.get());
        this.scope.value(validateName, { ref: validate });
        validate.errors = null;
        validate.schema = sch.schema;
        validate.schemaEnv = sch;
        if (sch.$async)
          validate.$async = true;
        if (this.opts.code.source === true) {
          validate.source = { validateName, validateCode, scopeValues: gen._values };
        }
        if (this.opts.unevaluated) {
          const { props, items } = schemaCxt;
          validate.evaluated = {
            props: props instanceof codegen_1.Name ? void 0 : props,
            items: items instanceof codegen_1.Name ? void 0 : items,
            dynamicProps: props instanceof codegen_1.Name,
            dynamicItems: items instanceof codegen_1.Name
          };
          if (validate.source)
            validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
        }
        sch.validate = validate;
        return sch;
      } catch (e) {
        delete sch.validate;
        delete sch.validateName;
        if (sourceCode)
          this.logger.error("Error compiling schema, function code:", sourceCode);
        throw e;
      } finally {
        this._compilations.delete(sch);
      }
    }
    exports.compileSchema = compileSchema;
    function resolveRef(root, baseId, ref) {
      var _a3;
      ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
      const schOrFunc = root.refs[ref];
      if (schOrFunc)
        return schOrFunc;
      let _sch = resolve6.call(this, root, ref);
      if (_sch === void 0) {
        const schema = (_a3 = root.localRefs) === null || _a3 === void 0 ? void 0 : _a3[ref];
        const { schemaId } = this.opts;
        if (schema)
          _sch = new SchemaEnv({ schema, schemaId, root, baseId });
      }
      if (_sch === void 0)
        return;
      return root.refs[ref] = inlineOrCompile.call(this, _sch);
    }
    exports.resolveRef = resolveRef;
    function inlineOrCompile(sch) {
      if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
        return sch.schema;
      return sch.validate ? sch : compileSchema.call(this, sch);
    }
    function getCompilingSchema(schEnv) {
      for (const sch of this._compilations) {
        if (sameSchemaEnv(sch, schEnv))
          return sch;
      }
    }
    exports.getCompilingSchema = getCompilingSchema;
    function sameSchemaEnv(s1, s2) {
      return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
    }
    function resolve6(root, ref) {
      let sch;
      while (typeof (sch = this.refs[ref]) == "string")
        ref = sch;
      return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
    }
    function resolveSchema(root, ref) {
      const p = this.opts.uriResolver.parse(ref);
      const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
      let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
      if (Object.keys(root.schema).length > 0 && refPath === baseId) {
        return getJsonPointer.call(this, p, root);
      }
      const id = (0, resolve_1.normalizeId)(refPath);
      const schOrRef = this.refs[id] || this.schemas[id];
      if (typeof schOrRef == "string") {
        const sch = resolveSchema.call(this, root, schOrRef);
        if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object")
          return;
        return getJsonPointer.call(this, p, sch);
      }
      if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object")
        return;
      if (!schOrRef.validate)
        compileSchema.call(this, schOrRef);
      if (id === (0, resolve_1.normalizeId)(ref)) {
        const { schema } = schOrRef;
        const { schemaId } = this.opts;
        const schId = schema[schemaId];
        if (schId)
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        return new SchemaEnv({ schema, schemaId, root, baseId });
      }
      return getJsonPointer.call(this, p, schOrRef);
    }
    exports.resolveSchema = resolveSchema;
    var PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
      "properties",
      "patternProperties",
      "enum",
      "dependencies",
      "definitions"
    ]);
    function getJsonPointer(parsedRef, { baseId, schema, root }) {
      var _a3;
      if (((_a3 = parsedRef.fragment) === null || _a3 === void 0 ? void 0 : _a3[0]) !== "/")
        return;
      for (const part of parsedRef.fragment.slice(1).split("/")) {
        if (typeof schema === "boolean")
          return;
        const partSchema = schema[(0, util_1.unescapeFragment)(part)];
        if (partSchema === void 0)
          return;
        schema = partSchema;
        const schId = typeof schema === "object" && schema[this.opts.schemaId];
        if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        }
      }
      let env;
      if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
        const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
        env = resolveSchema.call(this, root, $ref);
      }
      const { schemaId } = this.opts;
      env = env || new SchemaEnv({ schema, schemaId, root, baseId });
      if (env.schema !== env.root.schema)
        return env;
      return void 0;
    }
  }
});

// node_modules/ajv/dist/refs/data.json
var require_data = __commonJS({
  "node_modules/ajv/dist/refs/data.json"(exports, module) {
    module.exports = {
      $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
      description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
      type: "object",
      required: ["$data"],
      properties: {
        $data: {
          type: "string",
          anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
        }
      },
      additionalProperties: false
    };
  }
});

// node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS({
  "node_modules/fast-uri/lib/utils.js"(exports, module) {
    "use strict";
    var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
    var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
    var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
    var isPathCharacter = RegExp.prototype.test.bind(/^[\da-z\-._~!$&'()*+,;=:@/]$/iu);
    function stringArrayToHexStripped(input) {
      let acc = "";
      let code = 0;
      let i = 0;
      for (i = 0; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (code === 48) {
          continue;
        }
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
        break;
      }
      for (i += 1; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
      }
      return acc;
    }
    var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
    function consumeIsZone(buffer) {
      buffer.length = 0;
      return true;
    }
    function consumeHextets(buffer, address, output) {
      if (buffer.length) {
        const hex = stringArrayToHexStripped(buffer);
        if (hex !== "") {
          address.push(hex);
        } else {
          output.error = true;
          return false;
        }
        buffer.length = 0;
      }
      return true;
    }
    function getIPV6(input) {
      let tokenCount = 0;
      const output = { error: false, address: "", zone: "" };
      const address = [];
      const buffer = [];
      let endipv6Encountered = false;
      let endIpv6 = false;
      let consume = consumeHextets;
      for (let i = 0; i < input.length; i++) {
        const cursor = input[i];
        if (cursor === "[" || cursor === "]") {
          continue;
        }
        if (cursor === ":") {
          if (endipv6Encountered === true) {
            endIpv6 = true;
          }
          if (!consume(buffer, address, output)) {
            break;
          }
          if (++tokenCount > 7) {
            output.error = true;
            break;
          }
          if (i > 0 && input[i - 1] === ":") {
            endipv6Encountered = true;
          }
          address.push(":");
          continue;
        } else if (cursor === "%") {
          if (!consume(buffer, address, output)) {
            break;
          }
          consume = consumeIsZone;
        } else {
          buffer.push(cursor);
          continue;
        }
      }
      if (buffer.length) {
        if (consume === consumeIsZone) {
          output.zone = buffer.join("");
        } else if (endIpv6) {
          address.push(buffer.join(""));
        } else {
          address.push(stringArrayToHexStripped(buffer));
        }
      }
      output.address = address.join("");
      return output;
    }
    function normalizeIPv6(host) {
      if (findToken(host, ":") < 2) {
        return { host, isIPV6: false };
      }
      const ipv62 = getIPV6(host);
      if (!ipv62.error) {
        let newHost = ipv62.address;
        let escapedHost = ipv62.address;
        if (ipv62.zone) {
          newHost += "%" + ipv62.zone;
          escapedHost += "%25" + ipv62.zone;
        }
        return { host: newHost, isIPV6: true, escapedHost };
      } else {
        return { host, isIPV6: false };
      }
    }
    function findToken(str, token) {
      let ind = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === token) ind++;
      }
      return ind;
    }
    function removeDotSegments(path) {
      let input = path;
      const output = [];
      let nextSlash = -1;
      let len = 0;
      while (len = input.length) {
        if (len === 1) {
          if (input === ".") {
            break;
          } else if (input === "/") {
            output.push("/");
            break;
          } else {
            output.push(input);
            break;
          }
        } else if (len === 2) {
          if (input[0] === ".") {
            if (input[1] === ".") {
              break;
            } else if (input[1] === "/") {
              input = input.slice(2);
              continue;
            }
          } else if (input[0] === "/") {
            if (input[1] === "." || input[1] === "/") {
              output.push("/");
              break;
            }
          }
        } else if (len === 3) {
          if (input === "/..") {
            if (output.length !== 0) {
              output.pop();
            }
            output.push("/");
            break;
          }
        }
        if (input[0] === ".") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(3);
              continue;
            }
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(2);
              continue;
            } else if (input[2] === ".") {
              if (input[3] === "/") {
                input = input.slice(3);
                if (output.length !== 0) {
                  output.pop();
                }
                continue;
              }
            }
          }
        }
        if ((nextSlash = input.indexOf("/", 1)) === -1) {
          output.push(input);
          break;
        } else {
          output.push(input.slice(0, nextSlash));
          input = input.slice(nextSlash);
        }
      }
      return output.join("");
    }
    var HOST_DELIMS = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" };
    var HOST_DELIM_RE = /[@/?#:]/g;
    var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
    function reescapeHostDelimiters(host, isIP) {
      const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
      re.lastIndex = 0;
      return host.replace(re, (ch) => HOST_DELIMS[ch]);
    }
    function normalizePercentEncoding(input, decodeUnreserved = false) {
      if (input.indexOf("%") === -1) {
        return input;
      }
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decodeUnreserved && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        output += input[i];
      }
      return output;
    }
    function normalizePathEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decoded !== "." && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isPathCharacter(input[i])) {
          output += input[i];
        } else {
          output += escape(input[i]);
        }
      }
      return output;
    }
    function escapePreservingEscapes(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        output += escape(input[i]);
      }
      return output;
    }
    function recomposeAuthority(component) {
      const uriTokens = [];
      if (component.userinfo !== void 0) {
        uriTokens.push(component.userinfo);
        uriTokens.push("@");
      }
      if (component.host !== void 0) {
        let host = unescape(component.host);
        if (!isIPv4(host)) {
          const ipV6res = normalizeIPv6(host);
          if (ipV6res.isIPV6 === true) {
            host = `[${ipV6res.escapedHost}]`;
          } else {
            host = reescapeHostDelimiters(host, false);
          }
        }
        uriTokens.push(host);
      }
      if (typeof component.port === "number" || typeof component.port === "string") {
        uriTokens.push(":");
        uriTokens.push(String(component.port));
      }
      return uriTokens.length ? uriTokens.join("") : void 0;
    }
    module.exports = {
      nonSimpleDomain,
      recomposeAuthority,
      reescapeHostDelimiters,
      normalizePercentEncoding,
      normalizePathEncoding,
      escapePreservingEscapes,
      removeDotSegments,
      isIPv4,
      isUUID,
      normalizeIPv6,
      stringArrayToHexStripped
    };
  }
});

// node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS({
  "node_modules/fast-uri/lib/schemes.js"(exports, module) {
    "use strict";
    var { isUUID } = require_utils();
    var URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
    var supportedSchemeNames = (
      /** @type {const} */
      [
        "http",
        "https",
        "ws",
        "wss",
        "urn",
        "urn:uuid"
      ]
    );
    function isValidSchemeName(name) {
      return supportedSchemeNames.indexOf(
        /** @type {*} */
        name
      ) !== -1;
    }
    function wsIsSecure(wsComponent) {
      if (wsComponent.secure === true) {
        return true;
      } else if (wsComponent.secure === false) {
        return false;
      } else if (wsComponent.scheme) {
        return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
      } else {
        return false;
      }
    }
    function httpParse(component) {
      if (!component.host) {
        component.error = component.error || "HTTP URIs must have a host.";
      }
      return component;
    }
    function httpSerialize(component) {
      const secure = String(component.scheme).toLowerCase() === "https";
      if (component.port === (secure ? 443 : 80) || component.port === "") {
        component.port = void 0;
      }
      if (!component.path) {
        component.path = "/";
      }
      return component;
    }
    function wsParse(wsComponent) {
      wsComponent.secure = wsIsSecure(wsComponent);
      wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
      wsComponent.path = void 0;
      wsComponent.query = void 0;
      return wsComponent;
    }
    function wsSerialize(wsComponent) {
      if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
        wsComponent.port = void 0;
      }
      if (typeof wsComponent.secure === "boolean") {
        wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
        wsComponent.secure = void 0;
      }
      if (wsComponent.resourceName) {
        const [path, query] = wsComponent.resourceName.split("?");
        wsComponent.path = path && path !== "/" ? path : void 0;
        wsComponent.query = query;
        wsComponent.resourceName = void 0;
      }
      wsComponent.fragment = void 0;
      return wsComponent;
    }
    function urnParse(urnComponent, options) {
      if (!urnComponent.path) {
        urnComponent.error = "URN can not be parsed";
        return urnComponent;
      }
      const matches = urnComponent.path.match(URN_REG);
      if (matches) {
        const scheme = options.scheme || urnComponent.scheme || "urn";
        urnComponent.nid = matches[1].toLowerCase();
        urnComponent.nss = matches[2];
        const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
        const schemeHandler = getSchemeHandler(urnScheme);
        urnComponent.path = void 0;
        if (schemeHandler) {
          urnComponent = schemeHandler.parse(urnComponent, options);
        }
      } else {
        urnComponent.error = urnComponent.error || "URN can not be parsed.";
      }
      return urnComponent;
    }
    function urnSerialize(urnComponent, options) {
      if (urnComponent.nid === void 0) {
        throw new Error("URN without nid cannot be serialized");
      }
      const scheme = options.scheme || urnComponent.scheme || "urn";
      const nid = urnComponent.nid.toLowerCase();
      const urnScheme = `${scheme}:${options.nid || nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      if (schemeHandler) {
        urnComponent = schemeHandler.serialize(urnComponent, options);
      }
      const uriComponent = urnComponent;
      const nss = urnComponent.nss;
      uriComponent.path = `${nid || options.nid}:${nss}`;
      options.skipEscape = true;
      return uriComponent;
    }
    function urnuuidParse(urnComponent, options) {
      const uuidComponent = urnComponent;
      uuidComponent.uuid = uuidComponent.nss;
      uuidComponent.nss = void 0;
      if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
        uuidComponent.error = uuidComponent.error || "UUID is not valid.";
      }
      return uuidComponent;
    }
    function urnuuidSerialize(uuidComponent) {
      const urnComponent = uuidComponent;
      urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
      return urnComponent;
    }
    var http = (
      /** @type {SchemeHandler} */
      {
        scheme: "http",
        domainHost: true,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var https = (
      /** @type {SchemeHandler} */
      {
        scheme: "https",
        domainHost: http.domainHost,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var ws = (
      /** @type {SchemeHandler} */
      {
        scheme: "ws",
        domainHost: true,
        parse: wsParse,
        serialize: wsSerialize
      }
    );
    var wss = (
      /** @type {SchemeHandler} */
      {
        scheme: "wss",
        domainHost: ws.domainHost,
        parse: ws.parse,
        serialize: ws.serialize
      }
    );
    var urn = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn",
        parse: urnParse,
        serialize: urnSerialize,
        skipNormalize: true
      }
    );
    var urnuuid = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn:uuid",
        parse: urnuuidParse,
        serialize: urnuuidSerialize,
        skipNormalize: true
      }
    );
    var SCHEMES = (
      /** @type {Record<SchemeName, SchemeHandler>} */
      {
        http,
        https,
        ws,
        wss,
        urn,
        "urn:uuid": urnuuid
      }
    );
    Object.setPrototypeOf(SCHEMES, null);
    function getSchemeHandler(scheme) {
      return scheme && (SCHEMES[
        /** @type {SchemeName} */
        scheme
      ] || SCHEMES[
        /** @type {SchemeName} */
        scheme.toLowerCase()
      ]) || void 0;
    }
    module.exports = {
      wsIsSecure,
      SCHEMES,
      isValidSchemeName,
      getSchemeHandler
    };
  }
});

// node_modules/fast-uri/index.js
var require_fast_uri = __commonJS({
  "node_modules/fast-uri/index.js"(exports, module) {
    "use strict";
    var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, escapePreservingEscapes, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
    var { SCHEMES, getSchemeHandler } = require_schemes();
    function normalize(uri, options) {
      if (typeof uri === "string") {
        uri = /** @type {T} */
        normalizeString(uri, options);
      } else if (typeof uri === "object") {
        uri = /** @type {T} */
        parse3(serialize(uri, options), options);
      }
      return uri;
    }
    function resolve6(baseURI, relativeURI, options) {
      const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
      const { parsed: baseParsed, malformedAuthorityOrPort: baseMalformed } = parseWithStatus(baseURI, schemelessOptions);
      const { parsed: relativeParsed, malformedAuthorityOrPort: relativeMalformed } = parseWithStatus(relativeURI, schemelessOptions);
      if (baseMalformed || relativeMalformed) {
        throw new Error(baseParsed.error || relativeParsed.error || "URI is malformed.");
      }
      const resolved = resolveComponent(baseParsed, relativeParsed, schemelessOptions, true);
      schemelessOptions.skipEscape = true;
      return serialize(resolved, schemelessOptions);
    }
    function resolveComponent(base, relative4, options, skipNormalization) {
      const target = {};
      if (!skipNormalization) {
        base = parse3(serialize(base, options), options);
        relative4 = parse3(serialize(relative4, options), options);
      }
      options = options || {};
      if (!options.tolerant && relative4.scheme) {
        target.scheme = relative4.scheme;
        target.userinfo = relative4.userinfo;
        target.host = relative4.host;
        target.port = relative4.port;
        target.path = removeDotSegments(relative4.path || "");
        target.query = relative4.query;
      } else {
        if (relative4.userinfo !== void 0 || relative4.host !== void 0 || relative4.port !== void 0) {
          target.userinfo = relative4.userinfo;
          target.host = relative4.host;
          target.port = relative4.port;
          target.path = removeDotSegments(relative4.path || "");
          target.query = relative4.query;
        } else {
          if (!relative4.path) {
            target.path = base.path;
            if (relative4.query !== void 0) {
              target.query = relative4.query;
            } else {
              target.query = base.query;
            }
          } else {
            if (relative4.path[0] === "/") {
              target.path = removeDotSegments(relative4.path);
            } else {
              if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) {
                target.path = "/" + relative4.path;
              } else if (!base.path) {
                target.path = relative4.path;
              } else {
                target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative4.path;
              }
              target.path = removeDotSegments(target.path);
            }
            target.query = relative4.query;
          }
          target.userinfo = base.userinfo;
          target.host = base.host;
          target.port = base.port;
        }
        target.scheme = base.scheme;
      }
      target.fragment = relative4.fragment;
      return target;
    }
    function equal(uriA, uriB, options) {
      const normalizedA = normalizeComparableURI(uriA, options);
      const normalizedB = normalizeComparableURI(uriB, options);
      return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA.toLowerCase() === normalizedB.toLowerCase();
    }
    function serialize(cmpts, opts) {
      const component = {
        host: cmpts.host,
        scheme: cmpts.scheme,
        userinfo: cmpts.userinfo,
        port: cmpts.port,
        path: cmpts.path,
        query: cmpts.query,
        nid: cmpts.nid,
        nss: cmpts.nss,
        uuid: cmpts.uuid,
        fragment: cmpts.fragment,
        reference: cmpts.reference,
        resourceName: cmpts.resourceName,
        secure: cmpts.secure,
        error: ""
      };
      const options = Object.assign({}, opts);
      const uriTokens = [];
      const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
      if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
      if (component.path !== void 0) {
        if (!options.skipEscape) {
          component.path = escapePreservingEscapes(component.path);
          if (component.scheme !== void 0) {
            component.path = component.path.split("%3A").join(":");
          }
        } else {
          component.path = normalizePercentEncoding(component.path);
        }
      }
      if (options.reference !== "suffix" && component.scheme) {
        uriTokens.push(component.scheme, ":");
      }
      const authority = recomposeAuthority(component);
      if (authority !== void 0) {
        if (options.reference !== "suffix") {
          uriTokens.push("//");
        }
        uriTokens.push(authority);
        if (component.path && component.path[0] !== "/") {
          uriTokens.push("/");
        }
      }
      if (component.path !== void 0) {
        let s = component.path;
        if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
          s = removeDotSegments(s);
        }
        if (authority === void 0 && s[0] === "/" && s[1] === "/") {
          s = "/%2F" + s.slice(2);
        }
        uriTokens.push(s);
      }
      if (component.query !== void 0) {
        uriTokens.push("?", component.query);
      }
      if (component.fragment !== void 0) {
        uriTokens.push("#", component.fragment);
      }
      return uriTokens.join("");
    }
    var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
    var AUTHORITY_PREFIX = /^(?:[^#/:?]+:)?\/\/([^/?#]*)/;
    var AUTHORITY_INTRODUCER_REGION = /^(?:[^#/:?]+:)?([/\\\t\n\r]*)/;
    function getParseError(parsed, matches) {
      if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") {
        return 'URI path must start with "/" when authority is present.';
      }
      if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) {
        return "URI port is malformed.";
      }
      return void 0;
    }
    function parseWithStatus(uri, opts) {
      const options = Object.assign({}, opts);
      const parsed = {
        scheme: void 0,
        userinfo: void 0,
        host: "",
        port: void 0,
        path: "",
        query: void 0,
        fragment: void 0
      };
      let malformedAuthorityOrPort = false;
      let isIP = false;
      if (options.reference === "suffix") {
        if (options.scheme) {
          uri = options.scheme + ":" + uri;
        } else {
          uri = "//" + uri;
        }
      }
      const authorityMatch = uri.match(AUTHORITY_PREFIX);
      if (authorityMatch !== null && authorityMatch[1].indexOf("\\") !== -1) {
        parsed.error = "URI authority must not contain a literal backslash.";
        malformedAuthorityOrPort = true;
      }
      const introducerMatch = uri.match(AUTHORITY_INTRODUCER_REGION);
      if (introducerMatch !== null) {
        const region = introducerMatch[1];
        const normalizedRegion = region.replace(/[\t\n\r]/g, "");
        if (normalizedRegion.length >= 2) {
          if (normalizedRegion.slice(0, 2) !== "//") {
            parsed.error = parsed.error || "URI authority must not contain a literal backslash.";
            malformedAuthorityOrPort = true;
          } else if (region.length !== normalizedRegion.length) {
            parsed.error = parsed.error || "URI authority introducer must not contain whitespace.";
            malformedAuthorityOrPort = true;
          }
        }
      }
      const matches = uri.match(URI_PARSE);
      if (matches) {
        parsed.scheme = matches[1];
        parsed.userinfo = matches[3];
        parsed.host = matches[4];
        parsed.port = parseInt(matches[5], 10);
        parsed.path = matches[6] || "";
        parsed.query = matches[7];
        parsed.fragment = matches[8];
        if (isNaN(parsed.port)) {
          parsed.port = matches[5];
        }
        const parseError = getParseError(parsed, matches);
        if (parseError !== void 0) {
          parsed.error = parsed.error || parseError;
          malformedAuthorityOrPort = true;
        }
        if (parsed.host) {
          const ipv4result = isIPv4(parsed.host);
          if (ipv4result === false) {
            const ipv6result = normalizeIPv6(parsed.host);
            parsed.host = ipv6result.host.toLowerCase();
            isIP = ipv6result.isIPV6;
          } else {
            isIP = true;
          }
        }
        if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) {
          parsed.reference = "same-document";
        } else if (parsed.scheme === void 0) {
          parsed.reference = "relative";
        } else if (parsed.fragment === void 0) {
          parsed.reference = "absolute";
        } else {
          parsed.reference = "uri";
        }
        if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
          parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
        }
        const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
        if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
          if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) {
            try {
              parsed.host = new URL("http://" + parsed.host).hostname;
            } catch (e) {
              parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
            }
          }
        }
        if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
          if (uri.indexOf("%") !== -1) {
            if (parsed.scheme !== void 0) {
              parsed.scheme = unescape(parsed.scheme);
            }
            if (parsed.host !== void 0) {
              parsed.host = reescapeHostDelimiters(unescape(parsed.host), isIP);
            }
          }
          if (parsed.path) {
            parsed.path = normalizePathEncoding(parsed.path);
          }
          if (parsed.fragment) {
            try {
              parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
            } catch {
              parsed.error = parsed.error || "URI malformed";
            }
          }
        }
        if (schemeHandler && schemeHandler.parse) {
          schemeHandler.parse(parsed, options);
        }
      } else {
        parsed.error = parsed.error || "URI can not be parsed.";
      }
      return { parsed, malformedAuthorityOrPort };
    }
    function parse3(uri, opts) {
      return parseWithStatus(uri, opts).parsed;
    }
    function normalizeString(uri, opts) {
      return normalizeStringWithStatus(uri, opts).normalized;
    }
    function normalizeStringWithStatus(uri, opts) {
      const { parsed, malformedAuthorityOrPort } = parseWithStatus(uri, opts);
      return {
        normalized: malformedAuthorityOrPort ? uri : serialize(parsed, opts),
        malformedAuthorityOrPort
      };
    }
    function normalizeComparableURI(uri, opts) {
      if (typeof uri === "string") {
        const { normalized, malformedAuthorityOrPort } = normalizeStringWithStatus(uri, opts);
        return malformedAuthorityOrPort ? void 0 : normalized;
      }
      if (typeof uri === "object") {
        return serialize(uri, opts);
      }
    }
    var fastUri = {
      SCHEMES,
      normalize,
      resolve: resolve6,
      resolveComponent,
      equal,
      serialize,
      parse: parse3
    };
    module.exports = fastUri;
    module.exports.default = fastUri;
    module.exports.fastUri = fastUri;
  }
});

// node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS({
  "node_modules/ajv/dist/runtime/uri.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var uri = require_fast_uri();
    uri.code = 'require("ajv/dist/runtime/uri").default';
    exports.default = uri;
  }
});

// node_modules/ajv/dist/core.js
var require_core = __commonJS({
  "node_modules/ajv/dist/core.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    var ref_error_1 = require_ref_error();
    var rules_1 = require_rules();
    var compile_1 = require_compile();
    var codegen_2 = require_codegen();
    var resolve_1 = require_resolve();
    var dataType_1 = require_dataType();
    var util_1 = require_util();
    var $dataRefSchema = require_data();
    var uri_1 = require_uri();
    var defaultRegExp = (str, flags) => new RegExp(str, flags);
    defaultRegExp.code = "new RegExp";
    var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
    var EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
      "validate",
      "serialize",
      "parse",
      "wrapper",
      "root",
      "schema",
      "keyword",
      "pattern",
      "formats",
      "validate$data",
      "func",
      "obj",
      "Error"
    ]);
    var removedOptions = {
      errorDataPath: "",
      format: "`validateFormats: false` can be used instead.",
      nullable: '"nullable" keyword is supported by default.',
      jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
      extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
      missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
      processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
      sourceCode: "Use option `code: {source: true}`",
      strictDefaults: "It is default now, see option `strict`.",
      strictKeywords: "It is default now, see option `strict`.",
      uniqueItems: '"uniqueItems" keyword is always validated.',
      unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
      cache: "Map is used as cache, schema object as key.",
      serialize: "Map is used as cache, schema object as key.",
      ajvErrors: "It is default now."
    };
    var deprecatedOptions = {
      ignoreKeywordsWithRef: "",
      jsPropertySyntax: "",
      unicode: '"minLength"/"maxLength" account for unicode characters by default.'
    };
    var MAX_EXPRESSION = 200;
    function requiredOptions(o) {
      var _a3, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
      const s = o.strict;
      const _optz = (_a3 = o.code) === null || _a3 === void 0 ? void 0 : _a3.optimize;
      const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
      const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
      const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
      return {
        strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
        strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
        strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
        strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
        strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
        code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
        loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
        loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
        meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
        messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
        inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
        schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
        addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
        validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
        validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
        unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
        int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
        uriResolver
      };
    }
    var Ajv2 = class {
      constructor(opts = {}) {
        this.schemas = {};
        this.refs = {};
        this.formats = /* @__PURE__ */ Object.create(null);
        this._compilations = /* @__PURE__ */ new Set();
        this._loading = {};
        this._cache = /* @__PURE__ */ new Map();
        opts = this.opts = { ...opts, ...requiredOptions(opts) };
        const { es5, lines } = this.opts.code;
        this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
        this.logger = getLogger(opts.logger);
        const formatOpt = opts.validateFormats;
        opts.validateFormats = false;
        this.RULES = (0, rules_1.getRules)();
        checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
        checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
        this._metaOpts = getMetaSchemaOptions.call(this);
        if (opts.formats)
          addInitialFormats.call(this);
        this._addVocabularies();
        this._addDefaultMetaSchema();
        if (opts.keywords)
          addInitialKeywords.call(this, opts.keywords);
        if (typeof opts.meta == "object")
          this.addMetaSchema(opts.meta);
        addInitialSchemas.call(this);
        opts.validateFormats = formatOpt;
      }
      _addVocabularies() {
        this.addKeyword("$async");
      }
      _addDefaultMetaSchema() {
        const { $data, meta: meta2, schemaId } = this.opts;
        let _dataRefSchema = $dataRefSchema;
        if (schemaId === "id") {
          _dataRefSchema = { ...$dataRefSchema };
          _dataRefSchema.id = _dataRefSchema.$id;
          delete _dataRefSchema.$id;
        }
        if (meta2 && $data)
          this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
      }
      defaultMeta() {
        const { meta: meta2, schemaId } = this.opts;
        return this.opts.defaultMeta = typeof meta2 == "object" ? meta2[schemaId] || meta2 : void 0;
      }
      validate(schemaKeyRef, data) {
        let v;
        if (typeof schemaKeyRef == "string") {
          v = this.getSchema(schemaKeyRef);
          if (!v)
            throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
        } else {
          v = this.compile(schemaKeyRef);
        }
        const valid = v(data);
        if (!("$async" in v))
          this.errors = v.errors;
        return valid;
      }
      compile(schema, _meta) {
        const sch = this._addSchema(schema, _meta);
        return sch.validate || this._compileSchemaEnv(sch);
      }
      compileAsync(schema, meta2) {
        if (typeof this.opts.loadSchema != "function") {
          throw new Error("options.loadSchema should be a function");
        }
        const { loadSchema } = this.opts;
        return runCompileAsync.call(this, schema, meta2);
        async function runCompileAsync(_schema, _meta) {
          await loadMetaSchema.call(this, _schema.$schema);
          const sch = this._addSchema(_schema, _meta);
          return sch.validate || _compileAsync.call(this, sch);
        }
        async function loadMetaSchema($ref) {
          if ($ref && !this.getSchema($ref)) {
            await runCompileAsync.call(this, { $ref }, true);
          }
        }
        async function _compileAsync(sch) {
          try {
            return this._compileSchemaEnv(sch);
          } catch (e) {
            if (!(e instanceof ref_error_1.default))
              throw e;
            checkLoaded.call(this, e);
            await loadMissingSchema.call(this, e.missingSchema);
            return _compileAsync.call(this, sch);
          }
        }
        function checkLoaded({ missingSchema: ref, missingRef }) {
          if (this.refs[ref]) {
            throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
          }
        }
        async function loadMissingSchema(ref) {
          const _schema = await _loadSchema.call(this, ref);
          if (!this.refs[ref])
            await loadMetaSchema.call(this, _schema.$schema);
          if (!this.refs[ref])
            this.addSchema(_schema, ref, meta2);
        }
        async function _loadSchema(ref) {
          const p = this._loading[ref];
          if (p)
            return p;
          try {
            return await (this._loading[ref] = loadSchema(ref));
          } finally {
            delete this._loading[ref];
          }
        }
      }
      // Adds schema to the instance
      addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
        if (Array.isArray(schema)) {
          for (const sch of schema)
            this.addSchema(sch, void 0, _meta, _validateSchema);
          return this;
        }
        let id;
        if (typeof schema === "object") {
          const { schemaId } = this.opts;
          id = schema[schemaId];
          if (id !== void 0 && typeof id != "string") {
            throw new Error(`schema ${schemaId} must be string`);
          }
        }
        key = (0, resolve_1.normalizeId)(key || id);
        this._checkUnique(key);
        this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
        return this;
      }
      // Add schema that will be used to validate other schemas
      // options in META_IGNORE_OPTIONS are alway set to false
      addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
        this.addSchema(schema, key, true, _validateSchema);
        return this;
      }
      //  Validate schema against its meta-schema
      validateSchema(schema, throwOrLogError) {
        if (typeof schema == "boolean")
          return true;
        let $schema;
        $schema = schema.$schema;
        if ($schema !== void 0 && typeof $schema != "string") {
          throw new Error("$schema must be a string");
        }
        $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
        if (!$schema) {
          this.logger.warn("meta-schema not available");
          this.errors = null;
          return true;
        }
        const valid = this.validate($schema, schema);
        if (!valid && throwOrLogError) {
          const message = "schema is invalid: " + this.errorsText();
          if (this.opts.validateSchema === "log")
            this.logger.error(message);
          else
            throw new Error(message);
        }
        return valid;
      }
      // Get compiled schema by `key` or `ref`.
      // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
      getSchema(keyRef) {
        let sch;
        while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
          keyRef = sch;
        if (sch === void 0) {
          const { schemaId } = this.opts;
          const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
          sch = compile_1.resolveSchema.call(this, root, keyRef);
          if (!sch)
            return;
          this.refs[keyRef] = sch;
        }
        return sch.validate || this._compileSchemaEnv(sch);
      }
      // Remove cached schema(s).
      // If no parameter is passed all schemas but meta-schemas are removed.
      // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
      // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
      removeSchema(schemaKeyRef) {
        if (schemaKeyRef instanceof RegExp) {
          this._removeAllSchemas(this.schemas, schemaKeyRef);
          this._removeAllSchemas(this.refs, schemaKeyRef);
          return this;
        }
        switch (typeof schemaKeyRef) {
          case "undefined":
            this._removeAllSchemas(this.schemas);
            this._removeAllSchemas(this.refs);
            this._cache.clear();
            return this;
          case "string": {
            const sch = getSchEnv.call(this, schemaKeyRef);
            if (typeof sch == "object")
              this._cache.delete(sch.schema);
            delete this.schemas[schemaKeyRef];
            delete this.refs[schemaKeyRef];
            return this;
          }
          case "object": {
            const cacheKey = schemaKeyRef;
            this._cache.delete(cacheKey);
            let id = schemaKeyRef[this.opts.schemaId];
            if (id) {
              id = (0, resolve_1.normalizeId)(id);
              delete this.schemas[id];
              delete this.refs[id];
            }
            return this;
          }
          default:
            throw new Error("ajv.removeSchema: invalid parameter");
        }
      }
      // add "vocabulary" - a collection of keywords
      addVocabulary(definitions) {
        for (const def of definitions)
          this.addKeyword(def);
        return this;
      }
      addKeyword(kwdOrDef, def) {
        let keyword;
        if (typeof kwdOrDef == "string") {
          keyword = kwdOrDef;
          if (typeof def == "object") {
            this.logger.warn("these parameters are deprecated, see docs for addKeyword");
            def.keyword = keyword;
          }
        } else if (typeof kwdOrDef == "object" && def === void 0) {
          def = kwdOrDef;
          keyword = def.keyword;
          if (Array.isArray(keyword) && !keyword.length) {
            throw new Error("addKeywords: keyword must be string or non-empty array");
          }
        } else {
          throw new Error("invalid addKeywords parameters");
        }
        checkKeyword.call(this, keyword, def);
        if (!def) {
          (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
          return this;
        }
        keywordMetaschema.call(this, def);
        const definition = {
          ...def,
          type: (0, dataType_1.getJSONTypes)(def.type),
          schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
        };
        (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
        return this;
      }
      getKeyword(keyword) {
        const rule = this.RULES.all[keyword];
        return typeof rule == "object" ? rule.definition : !!rule;
      }
      // Remove keyword
      removeKeyword(keyword) {
        const { RULES } = this;
        delete RULES.keywords[keyword];
        delete RULES.all[keyword];
        for (const group of RULES.rules) {
          const i = group.rules.findIndex((rule) => rule.keyword === keyword);
          if (i >= 0)
            group.rules.splice(i, 1);
        }
        return this;
      }
      // Add format
      addFormat(name, format) {
        if (typeof format == "string")
          format = new RegExp(format);
        this.formats[name] = format;
        return this;
      }
      errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
        if (!errors || errors.length === 0)
          return "No errors";
        return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
      }
      $dataMetaSchema(metaSchema, keywordsJsonPointers) {
        const rules = this.RULES.all;
        metaSchema = JSON.parse(JSON.stringify(metaSchema));
        for (const jsonPointer of keywordsJsonPointers) {
          const segments = jsonPointer.split("/").slice(1);
          let keywords = metaSchema;
          for (const seg of segments)
            keywords = keywords[seg];
          for (const key in rules) {
            const rule = rules[key];
            if (typeof rule != "object")
              continue;
            const { $data } = rule.definition;
            const schema = keywords[key];
            if ($data && schema)
              keywords[key] = schemaOrData(schema);
          }
        }
        return metaSchema;
      }
      _removeAllSchemas(schemas, regex) {
        for (const keyRef in schemas) {
          const sch = schemas[keyRef];
          if (!regex || regex.test(keyRef)) {
            if (typeof sch == "string") {
              delete schemas[keyRef];
            } else if (sch && !sch.meta) {
              this._cache.delete(sch.schema);
              delete schemas[keyRef];
            }
          }
        }
      }
      _addSchema(schema, meta2, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
        let id;
        const { schemaId } = this.opts;
        if (typeof schema == "object") {
          id = schema[schemaId];
        } else {
          if (this.opts.jtd)
            throw new Error("schema must be object");
          else if (typeof schema != "boolean")
            throw new Error("schema must be object or boolean");
        }
        let sch = this._cache.get(schema);
        if (sch !== void 0)
          return sch;
        baseId = (0, resolve_1.normalizeId)(id || baseId);
        const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
        sch = new compile_1.SchemaEnv({ schema, schemaId, meta: meta2, baseId, localRefs });
        this._cache.set(sch.schema, sch);
        if (addSchema && !baseId.startsWith("#")) {
          if (baseId)
            this._checkUnique(baseId);
          this.refs[baseId] = sch;
        }
        if (validateSchema)
          this.validateSchema(schema, true);
        return sch;
      }
      _checkUnique(id) {
        if (this.schemas[id] || this.refs[id]) {
          throw new Error(`schema with key or id "${id}" already exists`);
        }
      }
      _compileSchemaEnv(sch) {
        if (sch.meta)
          this._compileMetaSchema(sch);
        else
          compile_1.compileSchema.call(this, sch);
        if (!sch.validate)
          throw new Error("ajv implementation error");
        return sch.validate;
      }
      _compileMetaSchema(sch) {
        const currentOpts = this.opts;
        this.opts = this._metaOpts;
        try {
          compile_1.compileSchema.call(this, sch);
        } finally {
          this.opts = currentOpts;
        }
      }
    };
    Ajv2.ValidationError = validation_error_1.default;
    Ajv2.MissingRefError = ref_error_1.default;
    exports.default = Ajv2;
    function checkOptions(checkOpts, options, msg, log = "error") {
      for (const key in checkOpts) {
        const opt = key;
        if (opt in options)
          this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
      }
    }
    function getSchEnv(keyRef) {
      keyRef = (0, resolve_1.normalizeId)(keyRef);
      return this.schemas[keyRef] || this.refs[keyRef];
    }
    function addInitialSchemas() {
      const optsSchemas = this.opts.schemas;
      if (!optsSchemas)
        return;
      if (Array.isArray(optsSchemas))
        this.addSchema(optsSchemas);
      else
        for (const key in optsSchemas)
          this.addSchema(optsSchemas[key], key);
    }
    function addInitialFormats() {
      for (const name in this.opts.formats) {
        const format = this.opts.formats[name];
        if (format)
          this.addFormat(name, format);
      }
    }
    function addInitialKeywords(defs) {
      if (Array.isArray(defs)) {
        this.addVocabulary(defs);
        return;
      }
      this.logger.warn("keywords option as map is deprecated, pass array");
      for (const keyword in defs) {
        const def = defs[keyword];
        if (!def.keyword)
          def.keyword = keyword;
        this.addKeyword(def);
      }
    }
    function getMetaSchemaOptions() {
      const metaOpts = { ...this.opts };
      for (const opt of META_IGNORE_OPTIONS)
        delete metaOpts[opt];
      return metaOpts;
    }
    var noLogs = { log() {
    }, warn() {
    }, error() {
    } };
    function getLogger(logger) {
      if (logger === false)
        return noLogs;
      if (logger === void 0)
        return console;
      if (logger.log && logger.warn && logger.error)
        return logger;
      throw new Error("logger must implement log, warn and error methods");
    }
    var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
    function checkKeyword(keyword, def) {
      const { RULES } = this;
      (0, util_1.eachItem)(keyword, (kwd) => {
        if (RULES.keywords[kwd])
          throw new Error(`Keyword ${kwd} is already defined`);
        if (!KEYWORD_NAME.test(kwd))
          throw new Error(`Keyword ${kwd} has invalid name`);
      });
      if (!def)
        return;
      if (def.$data && !("code" in def || "validate" in def)) {
        throw new Error('$data keyword must have "code" or "validate" function');
      }
    }
    function addRule(keyword, definition, dataType) {
      var _a3;
      const post = definition === null || definition === void 0 ? void 0 : definition.post;
      if (dataType && post)
        throw new Error('keyword with "post" flag cannot have "type"');
      const { RULES } = this;
      let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
      if (!ruleGroup) {
        ruleGroup = { type: dataType, rules: [] };
        RULES.rules.push(ruleGroup);
      }
      RULES.keywords[keyword] = true;
      if (!definition)
        return;
      const rule = {
        keyword,
        definition: {
          ...definition,
          type: (0, dataType_1.getJSONTypes)(definition.type),
          schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
        }
      };
      if (definition.before)
        addBeforeRule.call(this, ruleGroup, rule, definition.before);
      else
        ruleGroup.rules.push(rule);
      RULES.all[keyword] = rule;
      (_a3 = definition.implements) === null || _a3 === void 0 ? void 0 : _a3.forEach((kwd) => this.addKeyword(kwd));
    }
    function addBeforeRule(ruleGroup, rule, before) {
      const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
      if (i >= 0) {
        ruleGroup.rules.splice(i, 0, rule);
      } else {
        ruleGroup.rules.push(rule);
        this.logger.warn(`rule ${before} is not defined`);
      }
    }
    function keywordMetaschema(def) {
      let { metaSchema } = def;
      if (metaSchema === void 0)
        return;
      if (def.$data && this.opts.$data)
        metaSchema = schemaOrData(metaSchema);
      def.validateSchema = this.compile(metaSchema, true);
    }
    var $dataRef = {
      $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
    };
    function schemaOrData(schema) {
      return { anyOf: [schema, $dataRef] };
    }
  }
});

// node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/id.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var def = {
      keyword: "id",
      code() {
        throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/ref.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.callRef = exports.getValidate = void 0;
    var ref_error_1 = require_ref_error();
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var util_1 = require_util();
    var def = {
      keyword: "$ref",
      schemaType: "string",
      code(cxt) {
        const { gen, schema: $ref, it } = cxt;
        const { baseId, schemaEnv: env, validateName, opts, self } = it;
        const { root } = env;
        if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
          return callRootRef();
        const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
        if (schOrEnv === void 0)
          throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
        if (schOrEnv instanceof compile_1.SchemaEnv)
          return callValidate(schOrEnv);
        return inlineRefSchema(schOrEnv);
        function callRootRef() {
          if (env === root)
            return callRef(cxt, validateName, env, env.$async);
          const rootName = gen.scopeValue("root", { ref: root });
          return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
        }
        function callValidate(sch) {
          const v = getValidate(cxt, sch);
          callRef(cxt, v, sch, sch.$async);
        }
        function inlineRefSchema(sch) {
          const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
          const valid = gen.name("valid");
          const schCxt = cxt.subschema({
            schema: sch,
            dataTypes: [],
            schemaPath: codegen_1.nil,
            topSchemaRef: schName,
            errSchemaPath: $ref
          }, valid);
          cxt.mergeEvaluated(schCxt);
          cxt.ok(valid);
        }
      }
    };
    function getValidate(cxt, sch) {
      const { gen } = cxt;
      return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
    }
    exports.getValidate = getValidate;
    function callRef(cxt, v, sch, $async) {
      const { gen, it } = cxt;
      const { allErrors, schemaEnv: env, opts } = it;
      const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
      if ($async)
        callAsyncRef();
      else
        callSyncRef();
      function callAsyncRef() {
        if (!env.$async)
          throw new Error("async schema referenced by sync schema");
        const valid = gen.let("valid");
        gen.try(() => {
          gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
          addEvaluatedFrom(v);
          if (!allErrors)
            gen.assign(valid, true);
        }, (e) => {
          gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
          addErrorsFrom(e);
          if (!allErrors)
            gen.assign(valid, false);
        });
        cxt.ok(valid);
      }
      function callSyncRef() {
        cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
      }
      function addErrorsFrom(source) {
        const errs = (0, codegen_1._)`${source}.errors`;
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
        gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      }
      function addEvaluatedFrom(source) {
        var _a3;
        if (!it.opts.unevaluated)
          return;
        const schEvaluated = (_a3 = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a3 === void 0 ? void 0 : _a3.evaluated;
        if (it.props !== true) {
          if (schEvaluated && !schEvaluated.dynamicProps) {
            if (schEvaluated.props !== void 0) {
              it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
            }
          } else {
            const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
            it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
          }
        }
        if (it.items !== true) {
          if (schEvaluated && !schEvaluated.dynamicItems) {
            if (schEvaluated.items !== void 0) {
              it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
            }
          } else {
            const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
            it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
          }
        }
      }
    }
    exports.callRef = callRef;
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/core/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var id_1 = require_id();
    var ref_1 = require_ref();
    var core = [
      "$schema",
      "$id",
      "$defs",
      "$vocabulary",
      { keyword: "$comment" },
      "definitions",
      id_1.default,
      ref_1.default
    ];
    exports.default = core;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitNumber.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error2 = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    var def = {
      keyword: Object.keys(KWDs),
      type: "number",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/multipleOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    };
    var def = {
      keyword: "multipleOf",
      type: "number",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, schemaCode, it } = cxt;
        const prec = it.opts.multipleOfPrecision;
        const res = gen.let("res");
        const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
        cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitLength.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var ucs2length_1 = require_ucs2length();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxLength", "minLength"],
      type: "string",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode, it } = cxt;
        const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
        const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
        cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/pattern.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var util_1 = require_util();
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    };
    var def = {
      keyword: "pattern",
      type: "string",
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const u = it.opts.unicodeRegExp ? "u" : "";
        if ($data) {
          const { regExp } = it.opts.code;
          const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
          const valid = gen.let("valid");
          gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
          cxt.fail$data((0, codegen_1._)`!${valid}`);
        } else {
          const regExp = (0, code_1.usePattern)(cxt, schema);
          cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxProperties", "minProperties"],
      type: "object",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/required.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    };
    var def = {
      keyword: "required",
      type: "object",
      schemaType: "array",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, schema, schemaCode, data, $data, it } = cxt;
        const { opts } = it;
        if (!$data && schema.length === 0)
          return;
        const useLoop = schema.length >= opts.loopRequired;
        if (it.allErrors)
          allErrorsMode();
        else
          exitOnErrorMode();
        if (opts.strictRequired) {
          const props = cxt.parentSchema.properties;
          const { definedProperties } = cxt.it;
          for (const requiredKey of schema) {
            if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
              const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
              const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
              (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
            }
          }
        }
        function allErrorsMode() {
          if (useLoop || $data) {
            cxt.block$data(codegen_1.nil, loopAllRequired);
          } else {
            for (const prop of schema) {
              (0, code_1.checkReportMissingProp)(cxt, prop);
            }
          }
        }
        function exitOnErrorMode() {
          const missing = gen.let("missing");
          if (useLoop || $data) {
            const valid = gen.let("valid", true);
            cxt.block$data(valid, () => loopUntilMissing(missing, valid));
            cxt.ok(valid);
          } else {
            gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
            (0, code_1.reportMissingProp)(cxt, missing);
            gen.else();
          }
        }
        function loopAllRequired() {
          gen.forOf("prop", schemaCode, (prop) => {
            cxt.setParams({ missingProperty: prop });
            gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
          });
        }
        function loopUntilMissing(missing, valid) {
          cxt.setParams({ missingProperty: missing });
          gen.forOf(missing, schemaCode, () => {
            gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.error();
              gen.break();
            });
          }, codegen_1.nil);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/limitItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxItems", "minItems"],
      type: "array",
      schemaType: "number",
      $data: true,
      error: error2,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "node_modules/ajv/dist/runtime/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports.default = equal;
  }
});

// node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/uniqueItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dataType_1 = require_dataType();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    };
    var def = {
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
        if (!$data && !schema)
          return;
        const valid = gen.let("valid");
        const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
        cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
        cxt.ok(valid);
        function validateUniqueItems() {
          const i = gen.let("i", (0, codegen_1._)`${data}.length`);
          const j = gen.let("j");
          cxt.setParams({ i, j });
          gen.assign(valid, true);
          gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
        }
        function canOptimize() {
          return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
        }
        function loopN(i, j) {
          const item = gen.name("item");
          const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
          const indices = gen.const("indices", (0, codegen_1._)`{}`);
          gen.for((0, codegen_1._)`;${i}--;`, () => {
            gen.let(item, (0, codegen_1._)`${data}[${i}]`);
            gen.if(wrongType, (0, codegen_1._)`continue`);
            if (itemTypes.length > 1)
              gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
            gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
              gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
              cxt.error();
              gen.assign(valid, false).break();
            }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
          });
        }
        function loopN2(i, j) {
          const eql = (0, util_1.useFunc)(gen, equal_1.default);
          const outer = gen.name("outer");
          gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          })));
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/const.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    };
    var def = {
      keyword: "const",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schemaCode, schema } = cxt;
        if ($data || schema && typeof schema == "object") {
          cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
        } else {
          cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/enum.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error2 = {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    };
    var def = {
      keyword: "enum",
      schemaType: "array",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        if (!$data && schema.length === 0)
          throw new Error("enum must have non-empty array");
        const useLoop = schema.length >= it.opts.loopEnum;
        let eql;
        const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
        let valid;
        if (useLoop || $data) {
          valid = gen.let("valid");
          cxt.block$data(valid, loopEnum);
        } else {
          if (!Array.isArray(schema))
            throw new Error("ajv implementation error");
          const vSchema = gen.const("vSchema", schemaCode);
          valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
        }
        cxt.pass(valid);
        function loopEnum() {
          gen.assign(valid, false);
          gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
        }
        function equalCode(vSchema, i) {
          const sch = schema[i];
          return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS({
  "node_modules/ajv/dist/vocabularies/validation/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var limitNumber_1 = require_limitNumber();
    var multipleOf_1 = require_multipleOf();
    var limitLength_1 = require_limitLength();
    var pattern_1 = require_pattern();
    var limitProperties_1 = require_limitProperties();
    var required_1 = require_required();
    var limitItems_1 = require_limitItems();
    var uniqueItems_1 = require_uniqueItems();
    var const_1 = require_const();
    var enum_1 = require_enum();
    var validation = [
      // number
      limitNumber_1.default,
      multipleOf_1.default,
      // string
      limitLength_1.default,
      pattern_1.default,
      // object
      limitProperties_1.default,
      required_1.default,
      // array
      limitItems_1.default,
      uniqueItems_1.default,
      // any
      { keyword: "type", schemaType: ["string", "array"] },
      { keyword: "nullable", schemaType: "boolean" },
      const_1.default,
      enum_1.default
    ];
    exports.default = validation;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/additionalItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateAdditionalItems = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "additionalItems",
      type: "array",
      schemaType: ["boolean", "object"],
      before: "uniqueItems",
      error: error2,
      code(cxt) {
        const { parentSchema, it } = cxt;
        const { items } = parentSchema;
        if (!Array.isArray(items)) {
          (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
          return;
        }
        validateAdditionalItems(cxt, items);
      }
    };
    function validateAdditionalItems(cxt, items) {
      const { gen, schema, data, keyword, it } = cxt;
      it.items = true;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items.length });
        cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
        cxt.ok(valid);
      }
      function validateItems(valid) {
        gen.forRange("i", items.length, len, (i) => {
          cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
    exports.validateAdditionalItems = validateAdditionalItems;
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/items.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateTuple = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "array", "boolean"],
      before: "uniqueItems",
      code(cxt) {
        const { schema, it } = cxt;
        if (Array.isArray(schema))
          return validateTuple(cxt, "additionalItems", schema);
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    function validateTuple(cxt, extraItems, schArr = cxt.schema) {
      const { gen, parentSchema, data, keyword, it } = cxt;
      checkStrictTuple(parentSchema);
      if (it.opts.unevaluated && schArr.length && it.items !== true) {
        it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
      }
      const valid = gen.name("valid");
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      schArr.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
          keyword,
          schemaProp: i,
          dataProp: i
        }, valid));
        cxt.ok(valid);
      });
      function checkStrictTuple(sch) {
        const { opts, errSchemaPath } = it;
        const l = schArr.length;
        const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
        if (opts.strictTuples && !fullTuple) {
          const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
          (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
        }
      }
    }
    exports.validateTuple = validateTuple;
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/prefixItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var items_1 = require_items();
    var def = {
      keyword: "prefixItems",
      type: "array",
      schemaType: ["array"],
      before: "uniqueItems",
      code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/items2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var additionalItems_1 = require_additionalItems();
    var error2 = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      error: error2,
      code(cxt) {
        const { schema, parentSchema, it } = cxt;
        const { prefixItems } = parentSchema;
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        if (prefixItems)
          (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
        else
          cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/contains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    };
    var def = {
      keyword: "contains",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        let min;
        let max;
        const { minContains, maxContains } = parentSchema;
        if (it.opts.next) {
          min = minContains === void 0 ? 1 : minContains;
          max = maxContains;
        } else {
          min = 1;
        }
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        cxt.setParams({ min, max });
        if (max === void 0 && min === 0) {
          (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
          return;
        }
        if (max !== void 0 && min > max) {
          (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
          cxt.fail();
          return;
        }
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          let cond = (0, codegen_1._)`${len} >= ${min}`;
          if (max !== void 0)
            cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
          cxt.pass(cond);
          return;
        }
        it.items = true;
        const valid = gen.name("valid");
        if (max === void 0 && min === 1) {
          validateItems(valid, () => gen.if(valid, () => gen.break()));
        } else if (min === 0) {
          gen.let(valid, true);
          if (max !== void 0)
            gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
        } else {
          gen.let(valid, false);
          validateItemsWithCount();
        }
        cxt.result(valid, () => cxt.reset());
        function validateItemsWithCount() {
          const schValid = gen.name("_valid");
          const count3 = gen.let("count", 0);
          validateItems(schValid, () => gen.if(schValid, () => checkLimits(count3)));
        }
        function validateItems(_valid, block) {
          gen.forRange("i", 0, len, (i) => {
            cxt.subschema({
              keyword: "contains",
              dataProp: i,
              dataPropType: util_1.Type.Num,
              compositeRule: true
            }, _valid);
            block();
          });
        }
        function checkLimits(count3) {
          gen.code((0, codegen_1._)`${count3}++`);
          if (max === void 0) {
            gen.if((0, codegen_1._)`${count3} >= ${min}`, () => gen.assign(valid, true).break());
          } else {
            gen.if((0, codegen_1._)`${count3} > ${max}`, () => gen.assign(valid, false).break());
            if (min === 1)
              gen.assign(valid, true);
            else
              gen.if((0, codegen_1._)`${count3} >= ${min}`, () => gen.assign(valid, true));
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/dependencies.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    exports.error = {
      message: ({ params: { property, depsCount, deps } }) => {
        const property_ies = depsCount === 1 ? "property" : "properties";
        return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
      },
      params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
      // TODO change to reference
    };
    var def = {
      keyword: "dependencies",
      type: "object",
      schemaType: "object",
      error: exports.error,
      code(cxt) {
        const [propDeps, schDeps] = splitDependencies(cxt);
        validatePropertyDeps(cxt, propDeps);
        validateSchemaDeps(cxt, schDeps);
      }
    };
    function splitDependencies({ schema }) {
      const propertyDeps = {};
      const schemaDeps = {};
      for (const key in schema) {
        if (key === "__proto__")
          continue;
        const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
        deps[key] = schema[key];
      }
      return [propertyDeps, schemaDeps];
    }
    function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
      const { gen, data, it } = cxt;
      if (Object.keys(propertyDeps).length === 0)
        return;
      const missing = gen.let("missing");
      for (const prop in propertyDeps) {
        const deps = propertyDeps[prop];
        if (deps.length === 0)
          continue;
        const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
        cxt.setParams({
          property: prop,
          depsCount: deps.length,
          deps: deps.join(", ")
        });
        if (it.allErrors) {
          gen.if(hasProperty, () => {
            for (const depProp of deps) {
              (0, code_1.checkReportMissingProp)(cxt, depProp);
            }
          });
        } else {
          gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
    }
    exports.validatePropertyDeps = validatePropertyDeps;
    function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      for (const prop in schemaDeps) {
        if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
          continue;
        gen.if(
          (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties),
          () => {
            const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
            cxt.mergeValidEvaluated(schCxt, valid);
          },
          () => gen.var(valid, true)
          // TODO var
        );
        cxt.ok(valid);
      }
    }
    exports.validateSchemaDeps = validateSchemaDeps;
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/propertyNames.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    };
    var def = {
      keyword: "propertyNames",
      type: "object",
      schemaType: ["object", "boolean"],
      error: error2,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        const valid = gen.name("valid");
        gen.forIn("key", data, (key) => {
          cxt.setParams({ propertyName: key });
          cxt.subschema({
            keyword: "propertyNames",
            data: key,
            dataTypes: ["string"],
            propertyName: key,
            compositeRule: true
          }, valid);
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error(true);
            if (!it.allErrors)
              gen.break();
          });
        });
        cxt.ok(valid);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var util_1 = require_util();
    var error2 = {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    };
    var def = {
      keyword: "additionalProperties",
      type: ["object"],
      schemaType: ["boolean", "object"],
      allowUndefined: true,
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, opts } = it;
        it.props = true;
        if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
          return;
        const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
        const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
        checkAdditionalProperties();
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function checkAdditionalProperties() {
          gen.forIn("key", data, (key) => {
            if (!props.length && !patProps.length)
              additionalPropertyCode(key);
            else
              gen.if(isAdditional(key), () => additionalPropertyCode(key));
          });
        }
        function isAdditional(key) {
          let definedProp;
          if (props.length > 8) {
            const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
            definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
          } else if (props.length) {
            definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
          } else {
            definedProp = codegen_1.nil;
          }
          if (patProps.length) {
            definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
          }
          return (0, codegen_1.not)(definedProp);
        }
        function deleteAdditional(key) {
          gen.code((0, codegen_1._)`delete ${data}[${key}]`);
        }
        function additionalPropertyCode(key) {
          if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
            deleteAdditional(key);
            return;
          }
          if (schema === false) {
            cxt.setParams({ additionalProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            if (opts.removeAdditional === "failing") {
              applyAdditionalSchema(key, valid, false);
              gen.if((0, codegen_1.not)(valid), () => {
                cxt.reset();
                deleteAdditional(key);
              });
            } else {
              applyAdditionalSchema(key, valid);
              if (!allErrors)
                gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          }
        }
        function applyAdditionalSchema(key, valid, errors) {
          const subschema = {
            keyword: "additionalProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          };
          if (errors === false) {
            Object.assign(subschema, {
              compositeRule: true,
              createErrors: false,
              allErrors: false
            });
          }
          cxt.subschema(subschema, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/properties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var validate_1 = require_validate();
    var code_1 = require_code2();
    var util_1 = require_util();
    var additionalProperties_1 = require_additionalProperties();
    var def = {
      keyword: "properties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) {
          additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
        }
        const allProps = (0, code_1.allSchemaProperties)(schema);
        for (const prop of allProps) {
          it.definedProperties.add(prop);
        }
        if (it.opts.unevaluated && allProps.length && it.props !== true) {
          it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
        }
        const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
        if (properties.length === 0)
          return;
        const valid = gen.name("valid");
        for (const prop of properties) {
          if (hasDefault(prop)) {
            applyPropertySchema(prop);
          } else {
            gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
            applyPropertySchema(prop);
            if (!it.allErrors)
              gen.else().var(valid, true);
            gen.endIf();
          }
          cxt.it.definedProperties.add(prop);
          cxt.ok(valid);
        }
        function hasDefault(prop) {
          return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
        }
        function applyPropertySchema(prop) {
          cxt.subschema({
            keyword: "properties",
            schemaProp: prop,
            dataProp: prop
          }, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/patternProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var util_2 = require_util();
    var def = {
      keyword: "patternProperties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, data, parentSchema, it } = cxt;
        const { opts } = it;
        const patterns = (0, code_1.allSchemaProperties)(schema);
        const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
        if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
          return;
        }
        const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
        const valid = gen.name("valid");
        if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
          it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
        }
        const { props } = it;
        validatePatternProperties();
        function validatePatternProperties() {
          for (const pat of patterns) {
            if (checkProperties)
              checkMatchingProperties(pat);
            if (it.allErrors) {
              validateProperties(pat);
            } else {
              gen.var(valid, true);
              validateProperties(pat);
              gen.if(valid);
            }
          }
        }
        function checkMatchingProperties(pat) {
          for (const prop in checkProperties) {
            if (new RegExp(pat).test(prop)) {
              (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
            }
          }
        }
        function validateProperties(pat) {
          gen.forIn("key", data, (key) => {
            gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
              const alwaysValid = alwaysValidPatterns.includes(pat);
              if (!alwaysValid) {
                cxt.subschema({
                  keyword: "patternProperties",
                  schemaProp: pat,
                  dataProp: key,
                  dataPropType: util_2.Type.Str
                }, valid);
              }
              if (it.opts.unevaluated && props !== true) {
                gen.assign((0, codegen_1._)`${props}[${key}]`, true);
              } else if (!alwaysValid && !it.allErrors) {
                gen.if((0, codegen_1.not)(valid), () => gen.break());
              }
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/not.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "not",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      code(cxt) {
        const { gen, schema, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          cxt.fail();
          return;
        }
        const valid = gen.name("valid");
        cxt.subschema({
          keyword: "not",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, valid);
        cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
      },
      error: { message: "must NOT be valid" }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/anyOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var def = {
      keyword: "anyOf",
      schemaType: "array",
      trackErrors: true,
      code: code_1.validateUnion,
      error: { message: "must match a schema in anyOf" }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/oneOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    };
    var def = {
      keyword: "oneOf",
      schemaType: "array",
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, schema, parentSchema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        if (it.opts.discriminator && parentSchema.discriminator)
          return;
        const schArr = schema;
        const valid = gen.let("valid", false);
        const passing = gen.let("passing", null);
        const schValid = gen.name("_valid");
        cxt.setParams({ passing });
        gen.block(validateOneOf);
        cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
        function validateOneOf() {
          schArr.forEach((sch, i) => {
            let schCxt;
            if ((0, util_1.alwaysValidSchema)(it, sch)) {
              gen.var(schValid, true);
            } else {
              schCxt = cxt.subschema({
                keyword: "oneOf",
                schemaProp: i,
                compositeRule: true
              }, schValid);
            }
            if (i > 0) {
              gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
            }
            gen.if(schValid, () => {
              gen.assign(valid, true);
              gen.assign(passing, i);
              if (schCxt)
                cxt.mergeEvaluated(schCxt, codegen_1.Name);
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/allOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "allOf",
      schemaType: "array",
      code(cxt) {
        const { gen, schema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const valid = gen.name("valid");
        schema.forEach((sch, i) => {
          if ((0, util_1.alwaysValidSchema)(it, sch))
            return;
          const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
          cxt.ok(valid);
          cxt.mergeEvaluated(schCxt);
        });
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/if.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error2 = {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    };
    var def = {
      keyword: "if",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      error: error2,
      code(cxt) {
        const { gen, parentSchema, it } = cxt;
        if (parentSchema.then === void 0 && parentSchema.else === void 0) {
          (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
        }
        const hasThen = hasSchema(it, "then");
        const hasElse = hasSchema(it, "else");
        if (!hasThen && !hasElse)
          return;
        const valid = gen.let("valid", true);
        const schValid = gen.name("_valid");
        validateIf();
        cxt.reset();
        if (hasThen && hasElse) {
          const ifClause = gen.let("ifClause");
          cxt.setParams({ ifClause });
          gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
        } else if (hasThen) {
          gen.if(schValid, validateClause("then"));
        } else {
          gen.if((0, codegen_1.not)(schValid), validateClause("else"));
        }
        cxt.pass(valid, () => cxt.error(true));
        function validateIf() {
          const schCxt = cxt.subschema({
            keyword: "if",
            compositeRule: true,
            createErrors: false,
            allErrors: false
          }, schValid);
          cxt.mergeEvaluated(schCxt);
        }
        function validateClause(keyword, ifClause) {
          return () => {
            const schCxt = cxt.subschema({ keyword }, schValid);
            gen.assign(valid, schValid);
            cxt.mergeValidEvaluated(schCxt, valid);
            if (ifClause)
              gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
            else
              cxt.setParams({ ifClause: keyword });
          };
        }
      }
    };
    function hasSchema(it, keyword) {
      const schema = it.schema[keyword];
      return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
    }
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/thenElse.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["then", "else"],
      schemaType: ["object", "boolean"],
      code({ keyword, parentSchema, it }) {
        if (parentSchema.if === void 0)
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS({
  "node_modules/ajv/dist/vocabularies/applicator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var additionalItems_1 = require_additionalItems();
    var prefixItems_1 = require_prefixItems();
    var items_1 = require_items();
    var items2020_1 = require_items2020();
    var contains_1 = require_contains();
    var dependencies_1 = require_dependencies();
    var propertyNames_1 = require_propertyNames();
    var additionalProperties_1 = require_additionalProperties();
    var properties_1 = require_properties();
    var patternProperties_1 = require_patternProperties();
    var not_1 = require_not();
    var anyOf_1 = require_anyOf();
    var oneOf_1 = require_oneOf();
    var allOf_1 = require_allOf();
    var if_1 = require_if();
    var thenElse_1 = require_thenElse();
    function getApplicator(draft2020 = false) {
      const applicator = [
        // any
        not_1.default,
        anyOf_1.default,
        oneOf_1.default,
        allOf_1.default,
        if_1.default,
        thenElse_1.default,
        // object
        propertyNames_1.default,
        additionalProperties_1.default,
        dependencies_1.default,
        properties_1.default,
        patternProperties_1.default
      ];
      if (draft2020)
        applicator.push(prefixItems_1.default, items2020_1.default);
      else
        applicator.push(additionalItems_1.default, items_1.default);
      applicator.push(contains_1.default);
      return applicator;
    }
    exports.default = getApplicator;
  }
});

// node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS({
  "node_modules/ajv/dist/vocabularies/format/format.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error2 = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    };
    var def = {
      keyword: "format",
      type: ["number", "string"],
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt, ruleType) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const { opts, errSchemaPath, schemaEnv, self } = it;
        if (!opts.validateFormats)
          return;
        if ($data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
          const fType = gen.let("fType");
          const format = gen.let("format");
          gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
          cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
          function unknownFmt() {
            if (opts.strictSchema === false)
              return codegen_1.nil;
            return (0, codegen_1._)`${schemaCode} && !${format}`;
          }
          function invalidFmt() {
            const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
            const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
            return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
          }
        }
        function validateFormat() {
          const formatDef = self.formats[schema];
          if (!formatDef) {
            unknownFormat();
            return;
          }
          if (formatDef === true)
            return;
          const [fmtType, format, fmtRef] = getFormat(formatDef);
          if (fmtType === ruleType)
            cxt.pass(validCondition());
          function unknownFormat() {
            if (opts.strictSchema === false) {
              self.logger.warn(unknownMsg());
              return;
            }
            throw new Error(unknownMsg());
            function unknownMsg() {
              return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
            }
          }
          function getFormat(fmtDef) {
            const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
            const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
            if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
              return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
            }
            return ["string", fmtDef, fmt];
          }
          function validCondition() {
            if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
              if (!schemaEnv.$async)
                throw new Error("async format in sync schema");
              return (0, codegen_1._)`await ${fmtRef}(${data})`;
            }
            return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS({
  "node_modules/ajv/dist/vocabularies/format/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var format_1 = require_format();
    var format = [format_1.default];
    exports.default = format;
  }
});

// node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS({
  "node_modules/ajv/dist/vocabularies/metadata.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.contentVocabulary = exports.metadataVocabulary = void 0;
    exports.metadataVocabulary = [
      "title",
      "description",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "examples"
    ];
    exports.contentVocabulary = [
      "contentMediaType",
      "contentEncoding",
      "contentSchema"
    ];
  }
});

// node_modules/ajv/dist/vocabularies/draft7.js
var require_draft7 = __commonJS({
  "node_modules/ajv/dist/vocabularies/draft7.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var core_1 = require_core2();
    var validation_1 = require_validation();
    var applicator_1 = require_applicator();
    var format_1 = require_format2();
    var metadata_1 = require_metadata();
    var draft7Vocabularies = [
      core_1.default,
      validation_1.default,
      (0, applicator_1.default)(),
      format_1.default,
      metadata_1.metadataVocabulary,
      metadata_1.contentVocabulary
    ];
    exports.default = draft7Vocabularies;
  }
});

// node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS({
  "node_modules/ajv/dist/vocabularies/discriminator/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiscrError = void 0;
    var DiscrError;
    (function(DiscrError2) {
      DiscrError2["Tag"] = "tag";
      DiscrError2["Mapping"] = "mapping";
    })(DiscrError || (exports.DiscrError = DiscrError = {}));
  }
});

// node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS({
  "node_modules/ajv/dist/vocabularies/discriminator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var types_1 = require_types();
    var compile_1 = require_compile();
    var ref_error_1 = require_ref_error();
    var util_1 = require_util();
    var error2 = {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    };
    var def = {
      keyword: "discriminator",
      type: "object",
      schemaType: "object",
      error: error2,
      code(cxt) {
        const { gen, data, schema, parentSchema, it } = cxt;
        const { oneOf } = parentSchema;
        if (!it.opts.discriminator) {
          throw new Error("discriminator: requires discriminator option");
        }
        const tagName = schema.propertyName;
        if (typeof tagName != "string")
          throw new Error("discriminator: requires propertyName");
        if (schema.mapping)
          throw new Error("discriminator: mapping is not supported");
        if (!oneOf)
          throw new Error("discriminator: requires oneOf keyword");
        const valid = gen.let("valid", false);
        const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
        gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag, tagName }));
        cxt.ok(valid);
        function validateMapping() {
          const mapping = getMapping();
          gen.if(false);
          for (const tagValue in mapping) {
            gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
            gen.assign(valid, applyTagSchema(mapping[tagValue]));
          }
          gen.else();
          cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag, tagName });
          gen.endIf();
        }
        function applyTagSchema(schemaProp) {
          const _valid = gen.name("valid");
          const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
          cxt.mergeEvaluated(schCxt, codegen_1.Name);
          return _valid;
        }
        function getMapping() {
          var _a3;
          const oneOfMapping = {};
          const topRequired = hasRequired(parentSchema);
          let tagRequired = true;
          for (let i = 0; i < oneOf.length; i++) {
            let sch = oneOf[i];
            if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
              const ref = sch.$ref;
              sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
              if (sch instanceof compile_1.SchemaEnv)
                sch = sch.schema;
              if (sch === void 0)
                throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
            }
            const propSch = (_a3 = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a3 === void 0 ? void 0 : _a3[tagName];
            if (typeof propSch != "object") {
              throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
            }
            tagRequired = tagRequired && (topRequired || hasRequired(sch));
            addMappings(propSch, i);
          }
          if (!tagRequired)
            throw new Error(`discriminator: "${tagName}" must be required`);
          return oneOfMapping;
          function hasRequired({ required: required2 }) {
            return Array.isArray(required2) && required2.includes(tagName);
          }
          function addMappings(sch, i) {
            if (sch.const) {
              addMapping(sch.const, i);
            } else if (sch.enum) {
              for (const tagValue of sch.enum) {
                addMapping(tagValue, i);
              }
            } else {
              throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
            }
          }
          function addMapping(tagValue, i) {
            if (typeof tagValue != "string" || tagValue in oneOfMapping) {
              throw new Error(`discriminator: "${tagName}" values must be unique strings`);
            }
            oneOfMapping[tagValue] = i;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/ajv/dist/refs/json-schema-draft-07.json
var require_json_schema_draft_07 = __commonJS({
  "node_modules/ajv/dist/refs/json-schema-draft-07.json"(exports, module) {
    module.exports = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "http://json-schema.org/draft-07/schema#",
      title: "Core schema meta-schema",
      definitions: {
        schemaArray: {
          type: "array",
          minItems: 1,
          items: { $ref: "#" }
        },
        nonNegativeInteger: {
          type: "integer",
          minimum: 0
        },
        nonNegativeIntegerDefault0: {
          allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }]
        },
        simpleTypes: {
          enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
        },
        stringArray: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          default: []
        }
      },
      type: ["object", "boolean"],
      properties: {
        $id: {
          type: "string",
          format: "uri-reference"
        },
        $schema: {
          type: "string",
          format: "uri"
        },
        $ref: {
          type: "string",
          format: "uri-reference"
        },
        $comment: {
          type: "string"
        },
        title: {
          type: "string"
        },
        description: {
          type: "string"
        },
        default: true,
        readOnly: {
          type: "boolean",
          default: false
        },
        examples: {
          type: "array",
          items: true
        },
        multipleOf: {
          type: "number",
          exclusiveMinimum: 0
        },
        maximum: {
          type: "number"
        },
        exclusiveMaximum: {
          type: "number"
        },
        minimum: {
          type: "number"
        },
        exclusiveMinimum: {
          type: "number"
        },
        maxLength: { $ref: "#/definitions/nonNegativeInteger" },
        minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        pattern: {
          type: "string",
          format: "regex"
        },
        additionalItems: { $ref: "#" },
        items: {
          anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }],
          default: true
        },
        maxItems: { $ref: "#/definitions/nonNegativeInteger" },
        minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        uniqueItems: {
          type: "boolean",
          default: false
        },
        contains: { $ref: "#" },
        maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
        minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
        required: { $ref: "#/definitions/stringArray" },
        additionalProperties: { $ref: "#" },
        definitions: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        properties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          default: {}
        },
        patternProperties: {
          type: "object",
          additionalProperties: { $ref: "#" },
          propertyNames: { format: "regex" },
          default: {}
        },
        dependencies: {
          type: "object",
          additionalProperties: {
            anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }]
          }
        },
        propertyNames: { $ref: "#" },
        const: true,
        enum: {
          type: "array",
          items: true,
          minItems: 1,
          uniqueItems: true
        },
        type: {
          anyOf: [
            { $ref: "#/definitions/simpleTypes" },
            {
              type: "array",
              items: { $ref: "#/definitions/simpleTypes" },
              minItems: 1,
              uniqueItems: true
            }
          ]
        },
        format: { type: "string" },
        contentMediaType: { type: "string" },
        contentEncoding: { type: "string" },
        if: { $ref: "#" },
        then: { $ref: "#" },
        else: { $ref: "#" },
        allOf: { $ref: "#/definitions/schemaArray" },
        anyOf: { $ref: "#/definitions/schemaArray" },
        oneOf: { $ref: "#/definitions/schemaArray" },
        not: { $ref: "#" }
      },
      default: true
    };
  }
});

// node_modules/ajv/dist/ajv.js
var require_ajv = __commonJS({
  "node_modules/ajv/dist/ajv.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv = void 0;
    var core_1 = require_core();
    var draft7_1 = require_draft7();
    var discriminator_1 = require_discriminator();
    var draft7MetaSchema = require_json_schema_draft_07();
    var META_SUPPORT_DATA = ["/properties"];
    var META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";
    var Ajv2 = class extends core_1.default {
      _addVocabularies() {
        super._addVocabularies();
        draft7_1.default.forEach((v) => this.addVocabulary(v));
        if (this.opts.discriminator)
          this.addKeyword(discriminator_1.default);
      }
      _addDefaultMetaSchema() {
        super._addDefaultMetaSchema();
        if (!this.opts.meta)
          return;
        const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
        this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
        this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
      }
      defaultMeta() {
        return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
      }
    };
    exports.Ajv = Ajv2;
    module.exports = exports = Ajv2;
    module.exports.Ajv = Ajv2;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = Ajv2;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
      return validation_error_1.default;
    } });
    var ref_error_1 = require_ref_error();
    Object.defineProperty(exports, "MissingRefError", { enumerable: true, get: function() {
      return ref_error_1.default;
    } });
  }
});

// node_modules/ajv-formats/dist/formats.js
var require_formats = __commonJS({
  "node_modules/ajv-formats/dist/formats.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatNames = exports.fastFormats = exports.fullFormats = void 0;
    function fmtDef(validate, compare) {
      return { validate, compare };
    }
    exports.fullFormats = {
      // date: http://tools.ietf.org/html/rfc3339#section-5.6
      date: fmtDef(date3, compareDate),
      // date-time: http://tools.ietf.org/html/rfc3339#section-5.6
      time: fmtDef(getTime(true), compareTime),
      "date-time": fmtDef(getDateTime(true), compareDateTime),
      "iso-time": fmtDef(getTime(), compareIsoTime),
      "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
      // duration: https://tools.ietf.org/html/rfc3339#appendix-A
      duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
      uri,
      "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
      // uri-template: https://tools.ietf.org/html/rfc6570
      "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
      // For the source: https://gist.github.com/dperini/729294
      // For test cases: https://mathiasbynens.be/demo/url-regex
      url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
      email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
      hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
      // optimized https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/9780596802837/ch07s16.html
      ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
      ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
      regex,
      // uuid: http://tools.ietf.org/html/rfc4122
      uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
      // JSON-pointer: https://tools.ietf.org/html/rfc6901
      // uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
      "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
      "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
      // relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
      "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
      // the following formats are used by the openapi specification: https://spec.openapis.org/oas/v3.0.0#data-types
      // byte: https://github.com/miguelmota/is-base64
      byte,
      // signed 32 bit integer
      int32: { type: "number", validate: validateInt32 },
      // signed 64 bit integer
      int64: { type: "number", validate: validateInt64 },
      // C-type float
      float: { type: "number", validate: validateNumber },
      // C-type double
      double: { type: "number", validate: validateNumber },
      // hint to the UI to hide input strings
      password: true,
      // unchecked string payload
      binary: true
    };
    exports.fastFormats = {
      ...exports.fullFormats,
      date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
      time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
      "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
      "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
      "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
      // uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
      uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
      "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
      // email (sources from jsen validator):
      // http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
      // http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'wilful violation')
      email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
    };
    exports.formatNames = Object.keys(exports.fullFormats);
    function isLeapYear(year) {
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }
    var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
    var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    function date3(str) {
      const matches = DATE.exec(str);
      if (!matches)
        return false;
      const year = +matches[1];
      const month = +matches[2];
      const day = +matches[3];
      return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
    }
    function compareDate(d1, d2) {
      if (!(d1 && d2))
        return void 0;
      if (d1 > d2)
        return 1;
      if (d1 < d2)
        return -1;
      return 0;
    }
    var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
    function getTime(strictTimeZone) {
      return function time3(str) {
        const matches = TIME.exec(str);
        if (!matches)
          return false;
        const hr = +matches[1];
        const min = +matches[2];
        const sec = +matches[3];
        const tz = matches[4];
        const tzSign = matches[5] === "-" ? -1 : 1;
        const tzH = +(matches[6] || 0);
        const tzM = +(matches[7] || 0);
        if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
          return false;
        if (hr <= 23 && min <= 59 && sec < 60)
          return true;
        const utcMin = min - tzM * tzSign;
        const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
        return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
      };
    }
    function compareTime(s1, s2) {
      if (!(s1 && s2))
        return void 0;
      const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
      const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
      if (!(t1 && t2))
        return void 0;
      return t1 - t2;
    }
    function compareIsoTime(t1, t2) {
      if (!(t1 && t2))
        return void 0;
      const a1 = TIME.exec(t1);
      const a2 = TIME.exec(t2);
      if (!(a1 && a2))
        return void 0;
      t1 = a1[1] + a1[2] + a1[3];
      t2 = a2[1] + a2[2] + a2[3];
      if (t1 > t2)
        return 1;
      if (t1 < t2)
        return -1;
      return 0;
    }
    var DATE_TIME_SEPARATOR = /t|\s/i;
    function getDateTime(strictTimeZone) {
      const time3 = getTime(strictTimeZone);
      return function date_time(str) {
        const dateTime = str.split(DATE_TIME_SEPARATOR);
        return dateTime.length === 2 && date3(dateTime[0]) && time3(dateTime[1]);
      };
    }
    function compareDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const d1 = new Date(dt1).valueOf();
      const d2 = new Date(dt2).valueOf();
      if (!(d1 && d2))
        return void 0;
      return d1 - d2;
    }
    function compareIsoDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
      const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
      const res = compareDate(d1, d2);
      if (res === void 0)
        return void 0;
      return res || compareTime(t1, t2);
    }
    var NOT_URI_FRAGMENT = /\/|:/;
    var URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
    function uri(str) {
      return NOT_URI_FRAGMENT.test(str) && URI.test(str);
    }
    var BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
    function byte(str) {
      BYTE.lastIndex = 0;
      return BYTE.test(str);
    }
    var MIN_INT32 = -(2 ** 31);
    var MAX_INT32 = 2 ** 31 - 1;
    function validateInt32(value) {
      return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
    }
    function validateInt64(value) {
      return Number.isInteger(value);
    }
    function validateNumber() {
      return true;
    }
    var Z_ANCHOR = /[^\\]\\Z/;
    function regex(str) {
      if (Z_ANCHOR.test(str))
        return false;
      try {
        new RegExp(str);
        return true;
      } catch (e) {
        return false;
      }
    }
  }
});

// node_modules/ajv-formats/dist/limit.js
var require_limit = __commonJS({
  "node_modules/ajv-formats/dist/limit.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatLimitDefinition = void 0;
    var ajv_1 = require_ajv();
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      formatMaximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      formatMinimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      formatExclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      formatExclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error2 = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`should be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    exports.formatLimitDefinition = {
      keyword: Object.keys(KWDs),
      type: "string",
      schemaType: "string",
      $data: true,
      error: error2,
      code(cxt) {
        const { gen, data, schemaCode, keyword, it } = cxt;
        const { opts, self } = it;
        if (!opts.validateFormats)
          return;
        const fCxt = new ajv_1.KeywordCxt(it, self.RULES.all.format.definition, "format");
        if (fCxt.$data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fmt = gen.const("fmt", (0, codegen_1._)`${fmts}[${fCxt.schemaCode}]`);
          cxt.fail$data((0, codegen_1.or)((0, codegen_1._)`typeof ${fmt} != "object"`, (0, codegen_1._)`${fmt} instanceof RegExp`, (0, codegen_1._)`typeof ${fmt}.compare != "function"`, compareCode(fmt)));
        }
        function validateFormat() {
          const format = fCxt.schema;
          const fmtDef = self.formats[format];
          if (!fmtDef || fmtDef === true)
            return;
          if (typeof fmtDef != "object" || fmtDef instanceof RegExp || typeof fmtDef.compare != "function") {
            throw new Error(`"${keyword}": format "${format}" does not define "compare" function`);
          }
          const fmt = gen.scopeValue("formats", {
            key: format,
            ref: fmtDef,
            code: opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(format)}` : void 0
          });
          cxt.fail$data(compareCode(fmt));
        }
        function compareCode(fmt) {
          return (0, codegen_1._)`${fmt}.compare(${data}, ${schemaCode}) ${KWDs[keyword].fail} 0`;
        }
      },
      dependencies: ["format"]
    };
    var formatLimitPlugin = (ajv) => {
      ajv.addKeyword(exports.formatLimitDefinition);
      return ajv;
    };
    exports.default = formatLimitPlugin;
  }
});

// node_modules/ajv-formats/dist/index.js
var require_dist = __commonJS({
  "node_modules/ajv-formats/dist/index.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var formats_1 = require_formats();
    var limit_1 = require_limit();
    var codegen_1 = require_codegen();
    var fullName = new codegen_1.Name("fullFormats");
    var fastName = new codegen_1.Name("fastFormats");
    var formatsPlugin = (ajv, opts = { keywords: true }) => {
      if (Array.isArray(opts)) {
        addFormats(ajv, opts, formats_1.fullFormats, fullName);
        return ajv;
      }
      const [formats, exportName] = opts.mode === "fast" ? [formats_1.fastFormats, fastName] : [formats_1.fullFormats, fullName];
      const list = opts.formats || formats_1.formatNames;
      addFormats(ajv, list, formats, exportName);
      if (opts.keywords)
        (0, limit_1.default)(ajv);
      return ajv;
    };
    formatsPlugin.get = (name, mode = "full") => {
      const formats = mode === "fast" ? formats_1.fastFormats : formats_1.fullFormats;
      const f = formats[name];
      if (!f)
        throw new Error(`Unknown format "${name}"`);
      return f;
    };
    function addFormats(ajv, list, fs, exportName) {
      var _a3;
      var _b;
      (_a3 = (_b = ajv.opts.code).formats) !== null && _a3 !== void 0 ? _a3 : _b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`;
      for (const f of list)
        ajv.addFormat(f, fs[f]);
    }
    module.exports = exports = formatsPlugin;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = formatsPlugin;
  }
});

// src/server.mjs
import { readFile as readFile10 } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// node_modules/zod/v4/core/core.js
var _a;
// @__NO_SIDE_EFFECTS__
function $constructor(name, initializer3, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: /* @__PURE__ */ new Set()
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer3(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a3;
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $ZodAsyncError = class extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
};
var $ZodEncodeError = class extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
};
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}

// node_modules/zod/v4/core/util.js
var util_exports = {};
__export(util_exports, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  explicitlyAborted: () => explicitlyAborted,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  isObject: () => isObject,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  parsedType: () => parsedType,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  slugify: () => slugify,
  stringifyPrimitive: () => stringifyPrimitive,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {
}
function assertNever(_x) {
  throw new Error("Unexpected value in exhaustive check");
}
function assert(_) {
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array2, separator = "|") {
  return array2.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === void 0;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object3, key, getter) {
  let value = void 0;
  Object.defineProperty(object3, key, {
    get() {
      if (value === EVALUATING) {
        return void 0;
      }
      if (value === void 0) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object3, key, {
        value: v
        // configurable: true,
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0; i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0; i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {
};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === void 0)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
var primitiveTypes = /* @__PURE__ */ new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "symbol",
  "undefined"
]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== void 0) {
    if (params?.error !== void 0)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-34028234663852886e22, 34028234663852886e22],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = schema._zod.def.shape;
    for (const key in shape) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function merge(a, b) {
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class2, schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    }
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex; i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a3;
    (_a3 = iss).path ?? (_a3.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
  const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
  rest.path ?? (rest.path = []);
  rest.message = message;
  if (ctx?.reportInput) {
    rest.input = _input;
  }
  return rest;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base642) {
  const binaryString = atob(base642);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url2) {
  const base642 = base64url2.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base642.length % 4) % 4);
  return base64ToUint8Array(base642 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex) {
  const cleanHex = hex.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var Class = class {
  constructor(..._args) {
  }
};

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error2, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error2.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error2, mapper = (issue2) => issue2.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error3, path = []) => {
    for (const issue2 of error3.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, [...path, ...issue2.path]));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, [...path, ...issue2.path]);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, [...path, ...issue2.path]);
      } else {
        const fullpath = [...path, ...issue2.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue2));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue2));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    }
  };
  processError(error2);
  return fieldErrors;
}

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError();
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};

// node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version2) => {
  if (!version2)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version2}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time3 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time3}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a3;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a3 = inst._zod).onattach ?? (_a3.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a3;
    (_a3 = inst2._zod.bag).multipleOf ?? (_a3.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a3;
  $ZodCheck.init(inst, def);
  (_a3 = inst._zod.def).when ?? (_a3.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a3;
  $ZodCheck.init(inst, def);
  (_a3 = inst._zod.def).when ?? (_a3.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a3;
  $ZodCheck.init(inst, def);
  (_a3 = inst._zod.def).when ?? (_a3.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== void 0;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a3, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a3 = inst._zod).check ?? (_a3.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {
    });
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
var Doc = class {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split("\n").filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join("\n"));
  }
};

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 4,
  patch: 3
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a3;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a3 = inst._zod).deferred ?? (_a3.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError();
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError();
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {
      }
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === void 0)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      if (!def.normalize && def.protocol?.source === httpProtocol.source) {
        if (!/^https?:\/\//i.test(trimmed)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid URL format",
            input: payload.value,
            inst,
            continue: !def.abort
          });
          return;
        }
      }
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: def.hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv4`;
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv6`;
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error();
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error();
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error();
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error();
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64";
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base642 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base642.padEnd(Math.ceil(base642.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64url";
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {
      }
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = /* @__PURE__ */ new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
  const isPresent = key in input;
  if (result.issues.length) {
    if (isOptionalIn && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && !isOptionalIn) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: void 0,
        path: [key]
      });
    }
    return;
  }
  if (result.value === void 0) {
    if (isPresent) {
      final.value[key] = void 0;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const isOptionalIn = _catchall.optin === "optional";
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (key === "__proto__")
      continue;
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalIn = el._zod.optin === "optional";
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input, isOptionalIn, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = /* @__PURE__ */ Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      const schema = shape[key];
      const isOptionalIn = schema?._zod?.optin === "optional";
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(key)};`);
      if (isOptionalIn && isOptionalOut) {
        doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return void 0;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = /* @__PURE__ */ new Set();
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map = /* @__PURE__ */ new Map();
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map.set(v, o);
      }
    }
    return map;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback || ctx.direction === "backward") {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      options: Array.from(disc.value.keys()),
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = /* @__PURE__ */ new Map();
  let unrecIssue;
  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ?? (unrecIssue = iss);
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).l = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).r = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length && unrecIssue) {
    result.issues.push({ ...unrecIssue, keys: bothKeys });
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values) {
      payload.value = {};
      const recordKeys = /* @__PURE__ */ new Set();
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[outKey] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        payload.fallback = true;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError();
    }
    payload.value = _out;
    payload.fallback = true;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (input === void 0 && (result.issues.length || result.fallback)) {
    return { issues: [], value: void 0 };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const input = payload.value;
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, input));
      return handleOptionalResult(result, input);
    }
    if (payload.value === void 0) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === void 0) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === void 0) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === void 0) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
          payload.fallback = true;
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
      payload.fallback = true;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues, fallback: left.fallback }, ctx);
}
var $ZodPreprocess = /* @__PURE__ */ $constructor("$ZodPreprocess", (inst, def) => {
  $ZodPipe.init(inst, def);
});
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
  defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      // incorporates params.error into issue reporting
      path: [...inst._zod.def.path ?? []],
      // incorporates params.error into issue reporting
      continue: !inst._zod.def.abort
      // params: inst._zod.def.params,
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}

// node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    // Compatibility: "nan" -> "NaN" for display
    nan: "NaN"
    // All other type names omitted - they fall back to raw values via ?? operator
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type": {
        const expected = TypeDictionary[issue2.expected] ?? issue2.expected;
        const receivedType = parsedType(issue2.input);
        const received = TypeDictionary[receivedType] ?? receivedType;
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue2.origin}`;
      case "invalid_union":
        if (issue2.options && Array.isArray(issue2.options) && issue2.options.length > 0) {
          const opts = issue2.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue2.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}

// node_modules/zod/v4/core/registries.js
var _a2;
var $ZodRegistry = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
  }
  add(schema, ..._meta) {
    const meta2 = _meta[0];
    this._map.set(schema, meta2);
    if (meta2 && typeof meta2 === "object" && "id" in meta2) {
      this._idmap.set(meta2.id, schema);
    }
    return this;
  }
  clear() {
    this._map = /* @__PURE__ */ new WeakMap();
    this._idmap = /* @__PURE__ */ new Map();
    return this;
  }
  remove(schema) {
    const meta2 = this._map.get(schema);
    if (meta2 && typeof meta2 === "object" && "id" in meta2) {
      this._idmap.delete(meta2.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : void 0;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
};
function registry() {
  return new $ZodRegistry();
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;

// node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
// @__NO_SIDE_EFFECTS__
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
  return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
  return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
  return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
  return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    // get element() {
    //   return element;
    // },
    ...normalizeParams(params)
  });
}
// @__NO_SIDE_EFFECTS__
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
  const ch = /* @__PURE__ */ _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}

// node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {
    }),
    io: params?.io ?? "output",
    counter: 0,
    seen: /* @__PURE__ */ new Map(),
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    external: params?.external ?? void 0
  };
}
function process2(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a3;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: void 0, path: _params.path };
  ctx.seen.set(schema, result);
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      process2(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta2 = ctx.metadataRegistry.get(schema);
  if (meta2)
    Object.assign(result.schema, meta2);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a3 = result.schema).default ?? (_a3.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const idToSchema = /* @__PURE__ */ new Map();
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id2) => id2);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) {
      return { ref: "#" };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + defId };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema2 = seen.schema;
    for (const key in schema2) {
      delete schema2[key];
    }
    schema2.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
        continue;
      }
    }
  }
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema2 = seen.def ?? seen.schema;
    const _cached = { ...schema2 };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema2.allOf = schema2.allOf ?? [];
        schema2.allOf.push(refSchema);
      } else {
        Object.assign(schema2, refSchema);
      }
      Object.assign(schema2, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema2[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema2) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema2[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema2.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema2) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema2[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema2[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema2,
      path: seen.path ?? []
    });
  };
  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {
  } else {
  }
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  Object.assign(result, root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== void 0 && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      if (seen.def.id === seen.defId)
        delete seen.def.id;
      defs[seen.defId] = seen.def;
    }
  }
  if (ctx.external) {
  } else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};

// node_modules/zod/v4/core/json-schema-processors.js
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
  // do not set
};
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time") {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const regexes = [...patterns];
    if (regexes.length === 1)
      json.pattern = regexes[0].source;
    else if (regexes.length > 1) {
      json.allOf = [
        ...regexes.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
  if (typeof format === "string" && format.includes("int"))
    json.type = "integer";
  else
    json.type = "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (typeof multipleOf === "number")
    json.multipleOf = multipleOf;
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var nullProcessor = (_schema, ctx, json, _params) => {
  if (ctx.target === "openapi-3.0") {
    json.type = "string";
    json.nullable = true;
    json.enum = [null];
  } else {
    json.type = "null";
  }
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {
};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, _params) => {
  const def = schema._zod.def;
  const vals = [];
  for (const val of def.values) {
    if (val === void 0) {
      if (ctx.unrepresentable === "throw") {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      } else {
      }
    } else if (typeof val === "bigint") {
      if (ctx.unrepresentable === "throw") {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      } else {
        vals.push(Number(val));
      }
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {
  } else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Custom types cannot be represented in JSON Schema");
  }
};
var transformProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Transforms cannot be represented in JSON Schema");
  }
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = process2(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  json.properties = {};
  const shape = def.shape;
  for (const key in shape) {
    json.properties[key] = process2(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    });
  }
  const allKeys = new Set(Object.keys(shape));
  const requiredKeys = new Set([...allKeys].filter((key) => {
    const v = def.shape[key]._zod;
    if (ctx.io === "input") {
      return v.optin === void 0;
    } else {
      return v.optout === void 0;
    }
  }));
  if (requiredKeys.size > 0) {
    json.required = Array.from(requiredKeys);
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = process2(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => process2(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = process2(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = process2(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
};
var recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const keyBag = keyType._zod.bag;
  const patterns = keyBag?.patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = process2(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      json.patternProperties[pattern.source] = valueSchema;
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = process2(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
    }
    json.additionalProperties = process2(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  if (keyValues) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues;
    }
  }
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io === "input")
    json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(void 0);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  process2(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js
function isZ4Schema(s) {
  const schema = s;
  return !!schema._zod;
}
function safeParse2(schema, data) {
  if (isZ4Schema(schema)) {
    const result2 = safeParse(schema, data);
    return result2;
  }
  const v3Schema = schema;
  const result = v3Schema.safeParse(data);
  return result;
}
function getObjectShape(schema) {
  if (!schema)
    return void 0;
  let rawShape;
  if (isZ4Schema(schema)) {
    const v4Schema = schema;
    rawShape = v4Schema._zod?.def?.shape;
  } else {
    const v3Schema = schema;
    rawShape = v3Schema.shape;
  }
  if (!rawShape)
    return void 0;
  if (typeof rawShape === "function") {
    try {
      return rawShape();
    } catch {
      return void 0;
    }
  }
  return rawShape;
}
function getLiteralValue(schema) {
  if (isZ4Schema(schema)) {
    const v4Schema = schema;
    const def2 = v4Schema._zod?.def;
    if (def2) {
      if (def2.value !== void 0)
        return def2.value;
      if (Array.isArray(def2.values) && def2.values.length > 0) {
        return def2.values[0];
      }
    }
  }
  const v3Schema = schema;
  const def = v3Schema._def;
  if (def) {
    if (def.value !== void 0)
      return def.value;
    if (Array.isArray(def.values) && def.values.length > 0) {
      return def.values[0];
    }
  }
  const directValue = schema.value;
  if (directValue !== void 0)
    return directValue;
  return void 0;
}

// node_modules/zod/v4/classic/iso.js
var iso_exports = {};
__export(iso_exports, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
      // enumerable: false,
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
      // enumerable: false,
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
      // enumerable: false,
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
      // enumerable: false,
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse3 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
var _installedGroups = /* @__PURE__ */ new WeakMap();
function _installLazyMethods(inst, group, methods) {
  const proto = Object.getPrototypeOf(inst);
  let installed = _installedGroups.get(proto);
  if (!installed) {
    installed = /* @__PURE__ */ new Set();
    _installedGroups.set(proto, installed);
  }
  if (installed.has(group))
    return;
  installed.add(group);
  for (const key in methods) {
    const fn = methods[key];
    Object.defineProperty(proto, key, {
      configurable: true,
      enumerable: false,
      get() {
        const bound = fn.bind(this);
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: bound
        });
        return bound;
      },
      set(v) {
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: v
        });
      }
    });
  }
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  Object.assign(inst["~standard"], {
    jsonSchema: {
      input: createStandardJSONSchemaMethod(inst, "input"),
      output: createStandardJSONSchemaMethod(inst, "output")
    }
  });
  inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.parse = (data, params) => parse2(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse3(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  _installLazyMethods(inst, "ZodType", {
    check(...chks) {
      const def2 = this.def;
      return this.clone(util_exports.mergeDefs(def2, {
        checks: [
          ...def2.checks ?? [],
          ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
        ]
      }), { parent: true });
    },
    with(...chks) {
      return this.check(...chks);
    },
    clone(def2, params) {
      return clone(this, def2, params);
    },
    brand() {
      return this;
    },
    register(reg, meta2) {
      reg.add(this, meta2);
      return this;
    },
    refine(check, params) {
      return this.check(refine(check, params));
    },
    superRefine(refinement, params) {
      return this.check(superRefine(refinement, params));
    },
    overwrite(fn) {
      return this.check(_overwrite(fn));
    },
    optional() {
      return optional(this);
    },
    exactOptional() {
      return exactOptional(this);
    },
    nullable() {
      return nullable(this);
    },
    nullish() {
      return optional(nullable(this));
    },
    nonoptional(params) {
      return nonoptional(this, params);
    },
    array() {
      return array(this);
    },
    or(arg) {
      return union([this, arg]);
    },
    and(arg) {
      return intersection(this, arg);
    },
    transform(tx) {
      return pipe(this, transform(tx));
    },
    default(d) {
      return _default(this, d);
    },
    prefault(d) {
      return prefault(this, d);
    },
    catch(params) {
      return _catch(this, params);
    },
    pipe(target) {
      return pipe(this, target);
    },
    readonly() {
      return readonly(this);
    },
    describe(description) {
      const cl = this.clone();
      globalRegistry.add(cl, { description });
      return cl;
    },
    meta(...args) {
      if (args.length === 0)
        return globalRegistry.get(this);
      const cl = this.clone();
      globalRegistry.add(cl, args[0]);
      return cl;
    },
    isOptional() {
      return this.safeParse(void 0).success;
    },
    isNullable() {
      return this.safeParse(null).success;
    },
    apply(fn) {
      return fn(this);
    }
  });
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  _installLazyMethods(inst, "_ZodString", {
    regex(...args) {
      return this.check(_regex(...args));
    },
    includes(...args) {
      return this.check(_includes(...args));
    },
    startsWith(...args) {
      return this.check(_startsWith(...args));
    },
    endsWith(...args) {
      return this.check(_endsWith(...args));
    },
    min(...args) {
      return this.check(_minLength(...args));
    },
    max(...args) {
      return this.check(_maxLength(...args));
    },
    length(...args) {
      return this.check(_length(...args));
    },
    nonempty(...args) {
      return this.check(_minLength(1, ...args));
    },
    lowercase(params) {
      return this.check(_lowercase(params));
    },
    uppercase(params) {
      return this.check(_uppercase(params));
    },
    trim() {
      return this.check(_trim());
    },
    normalize(...args) {
      return this.check(_normalize(...args));
    },
    toLowerCase() {
      return this.check(_toLowerCase());
    },
    toUpperCase() {
      return this.check(_toUpperCase());
    },
    slugify() {
      return this.check(_slugify());
    }
  });
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  _installLazyMethods(inst, "ZodNumber", {
    gt(value, params) {
      return this.check(_gt(value, params));
    },
    gte(value, params) {
      return this.check(_gte(value, params));
    },
    min(value, params) {
      return this.check(_gte(value, params));
    },
    lt(value, params) {
      return this.check(_lt(value, params));
    },
    lte(value, params) {
      return this.check(_lte(value, params));
    },
    max(value, params) {
      return this.check(_lte(value, params));
    },
    int(params) {
      return this.check(int(params));
    },
    safe(params) {
      return this.check(int(params));
    },
    positive(params) {
      return this.check(_gt(0, params));
    },
    nonnegative(params) {
      return this.check(_gte(0, params));
    },
    negative(params) {
      return this.check(_lt(0, params));
    },
    nonpositive(params) {
      return this.check(_lte(0, params));
    },
    multipleOf(value, params) {
      return this.check(_multipleOf(value, params));
    },
    step(value, params) {
      return this.check(_multipleOf(value, params));
    },
    finite() {
      return this;
    }
  });
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
  _installLazyMethods(inst, "ZodArray", {
    min(n, params) {
      return this.check(_minLength(n, params));
    },
    nonempty(params) {
      return this.check(_minLength(1, params));
    },
    max(n, params) {
      return this.check(_maxLength(n, params));
    },
    length(n, params) {
      return this.check(_length(n, params));
    },
    unwrap() {
      return this.element;
    }
  });
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  util_exports.defineLazy(inst, "shape", () => {
    return def.shape;
  });
  _installLazyMethods(inst, "ZodObject", {
    keyof() {
      return _enum(Object.keys(this._zod.def.shape));
    },
    catchall(catchall) {
      return this.clone({ ...this._zod.def, catchall });
    },
    passthrough() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    loose() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    strict() {
      return this.clone({ ...this._zod.def, catchall: never() });
    },
    strip() {
      return this.clone({ ...this._zod.def, catchall: void 0 });
    },
    extend(incoming) {
      return util_exports.extend(this, incoming);
    },
    safeExtend(incoming) {
      return util_exports.safeExtend(this, incoming);
    },
    merge(other) {
      return util_exports.merge(this, other);
    },
    pick(mask) {
      return util_exports.pick(this, mask);
    },
    omit(mask) {
      return util_exports.omit(this, mask);
    },
    partial(...args) {
      return util_exports.partial(ZodOptional, this, args[0]);
    },
    required(...args) {
      return util_exports.required(ZodNonOptional, this, args[0]);
    }
  });
});
function object2(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...util_exports.normalizeParams(params)
  };
  return new ZodObject(def);
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: unknown(),
    ...util_exports.normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...util_exports.normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...util_exports.normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...util_exports.normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...util_exports.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...util_exports.normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...util_exports.normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(util_exports.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(util_exports.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        payload.fallback = true;
        return payload;
      });
    }
    payload.value = output;
    payload.fallback = true;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : util_exports.shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...util_exports.normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
    // ...util.normalizeParams(params),
  });
}
var ZodPreprocess = /* @__PURE__ */ $constructor("ZodPreprocess", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodPreprocess.init(inst, def);
});
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
function preprocess(fn, schema) {
  return new ZodPreprocess({
    type: "pipe",
    in: transform(fn),
    out: schema
  });
}

// node_modules/zod/v4/classic/external.js
config(en_default());

// node_modules/@modelcontextprotocol/sdk/dist/esm/types.js
var LATEST_PROTOCOL_VERSION = "2025-11-25";
var SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
var RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
var JSONRPC_VERSION = "2.0";
var AssertObjectSchema = custom((v) => v !== null && (typeof v === "object" || typeof v === "function"));
var ProgressTokenSchema = union([string2(), number2().int()]);
var CursorSchema = string2();
var TaskCreationParamsSchema = looseObject({
  /**
   * Requested duration in milliseconds to retain task from creation.
   */
  ttl: number2().optional(),
  /**
   * Time in milliseconds to wait between task status requests.
   */
  pollInterval: number2().optional()
});
var TaskMetadataSchema = object2({
  ttl: number2().optional()
});
var RelatedTaskMetadataSchema = object2({
  taskId: string2()
});
var RequestMetaSchema = looseObject({
  /**
   * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
   */
  progressToken: ProgressTokenSchema.optional(),
  /**
   * If specified, this request is related to the provided task.
   */
  [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});
var BaseRequestParamsSchema = object2({
  /**
   * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
   */
  _meta: RequestMetaSchema.optional()
});
var TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * If specified, the caller is requesting task-augmented execution for this request.
   * The request will return a CreateTaskResult immediately, and the actual result can be
   * retrieved later via tasks/result.
   *
   * Task augmentation is subject to capability negotiation - receivers MUST declare support
   * for task augmentation of specific request types in their capabilities.
   */
  task: TaskMetadataSchema.optional()
});
var isTaskAugmentedRequestParams = (value) => TaskAugmentedRequestParamsSchema.safeParse(value).success;
var RequestSchema = object2({
  method: string2(),
  params: BaseRequestParamsSchema.loose().optional()
});
var NotificationsParamsSchema = object2({
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: RequestMetaSchema.optional()
});
var NotificationSchema = object2({
  method: string2(),
  params: NotificationsParamsSchema.loose().optional()
});
var ResultSchema = looseObject({
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: RequestMetaSchema.optional()
});
var RequestIdSchema = union([string2(), number2().int()]);
var JSONRPCRequestSchema = object2({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  ...RequestSchema.shape
}).strict();
var isJSONRPCRequest = (value) => JSONRPCRequestSchema.safeParse(value).success;
var JSONRPCNotificationSchema = object2({
  jsonrpc: literal(JSONRPC_VERSION),
  ...NotificationSchema.shape
}).strict();
var isJSONRPCNotification = (value) => JSONRPCNotificationSchema.safeParse(value).success;
var JSONRPCResultResponseSchema = object2({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  result: ResultSchema
}).strict();
var isJSONRPCResultResponse = (value) => JSONRPCResultResponseSchema.safeParse(value).success;
var ErrorCode;
(function(ErrorCode2) {
  ErrorCode2[ErrorCode2["ConnectionClosed"] = -32e3] = "ConnectionClosed";
  ErrorCode2[ErrorCode2["RequestTimeout"] = -32001] = "RequestTimeout";
  ErrorCode2[ErrorCode2["ParseError"] = -32700] = "ParseError";
  ErrorCode2[ErrorCode2["InvalidRequest"] = -32600] = "InvalidRequest";
  ErrorCode2[ErrorCode2["MethodNotFound"] = -32601] = "MethodNotFound";
  ErrorCode2[ErrorCode2["InvalidParams"] = -32602] = "InvalidParams";
  ErrorCode2[ErrorCode2["InternalError"] = -32603] = "InternalError";
  ErrorCode2[ErrorCode2["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
})(ErrorCode || (ErrorCode = {}));
var JSONRPCErrorResponseSchema = object2({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema.optional(),
  error: object2({
    /**
     * The error type that occurred.
     */
    code: number2().int(),
    /**
     * A short description of the error. The message SHOULD be limited to a concise single sentence.
     */
    message: string2(),
    /**
     * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
     */
    data: unknown().optional()
  })
}).strict();
var isJSONRPCErrorResponse = (value) => JSONRPCErrorResponseSchema.safeParse(value).success;
var JSONRPCMessageSchema = union([
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResultResponseSchema,
  JSONRPCErrorResponseSchema
]);
var JSONRPCResponseSchema = union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);
var EmptyResultSchema = ResultSchema.strict();
var CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
  /**
   * The ID of the request to cancel.
   *
   * This MUST correspond to the ID of a request previously issued in the same direction.
   */
  requestId: RequestIdSchema.optional(),
  /**
   * An optional string describing the reason for the cancellation. This MAY be logged or presented to the user.
   */
  reason: string2().optional()
});
var CancelledNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/cancelled"),
  params: CancelledNotificationParamsSchema
});
var IconSchema = object2({
  /**
   * URL or data URI for the icon.
   */
  src: string2(),
  /**
   * Optional MIME type for the icon.
   */
  mimeType: string2().optional(),
  /**
   * Optional array of strings that specify sizes at which the icon can be used.
   * Each string should be in WxH format (e.g., `"48x48"`, `"96x96"`) or `"any"` for scalable formats like SVG.
   *
   * If not provided, the client should assume that the icon can be used at any size.
   */
  sizes: array(string2()).optional(),
  /**
   * Optional specifier for the theme this icon is designed for. `light` indicates
   * the icon is designed to be used with a light background, and `dark` indicates
   * the icon is designed to be used with a dark background.
   *
   * If not provided, the client should assume the icon can be used with any theme.
   */
  theme: _enum(["light", "dark"]).optional()
});
var IconsSchema = object2({
  /**
   * Optional set of sized icons that the client can display in a user interface.
   *
   * Clients that support rendering icons MUST support at least the following MIME types:
   * - `image/png` - PNG images (safe, universal compatibility)
   * - `image/jpeg` (and `image/jpg`) - JPEG images (safe, universal compatibility)
   *
   * Clients that support rendering icons SHOULD also support:
   * - `image/svg+xml` - SVG images (scalable but requires security precautions)
   * - `image/webp` - WebP images (modern, efficient format)
   */
  icons: array(IconSchema).optional()
});
var BaseMetadataSchema = object2({
  /** Intended for programmatic or logical use, but used as a display name in past specs or fallback */
  name: string2(),
  /**
   * Intended for UI and end-user contexts — optimized to be human-readable and easily understood,
   * even by those unfamiliar with domain-specific terminology.
   *
   * If not provided, the name should be used for display (except for Tool,
   * where `annotations.title` should be given precedence over using `name`,
   * if present).
   */
  title: string2().optional()
});
var ImplementationSchema = BaseMetadataSchema.extend({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  version: string2(),
  /**
   * An optional URL of the website for this implementation.
   */
  websiteUrl: string2().optional(),
  /**
   * An optional human-readable description of what this implementation does.
   *
   * This can be used by clients or servers to provide context about their purpose
   * and capabilities. For example, a server might describe the types of resources
   * or tools it provides, while a client might describe its intended use case.
   */
  description: string2().optional()
});
var FormElicitationCapabilitySchema = intersection(object2({
  applyDefaults: boolean2().optional()
}), record(string2(), unknown()));
var ElicitationCapabilitySchema = preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) {
      return { form: {} };
    }
  }
  return value;
}, intersection(object2({
  form: FormElicitationCapabilitySchema.optional(),
  url: AssertObjectSchema.optional()
}), record(string2(), unknown()).optional()));
var ClientTasksCapabilitySchema = looseObject({
  /**
   * Present if the client supports listing tasks.
   */
  list: AssertObjectSchema.optional(),
  /**
   * Present if the client supports cancelling tasks.
   */
  cancel: AssertObjectSchema.optional(),
  /**
   * Capabilities for task creation on specific request types.
   */
  requests: looseObject({
    /**
     * Task support for sampling requests.
     */
    sampling: looseObject({
      createMessage: AssertObjectSchema.optional()
    }).optional(),
    /**
     * Task support for elicitation requests.
     */
    elicitation: looseObject({
      create: AssertObjectSchema.optional()
    }).optional()
  }).optional()
});
var ServerTasksCapabilitySchema = looseObject({
  /**
   * Present if the server supports listing tasks.
   */
  list: AssertObjectSchema.optional(),
  /**
   * Present if the server supports cancelling tasks.
   */
  cancel: AssertObjectSchema.optional(),
  /**
   * Capabilities for task creation on specific request types.
   */
  requests: looseObject({
    /**
     * Task support for tool requests.
     */
    tools: looseObject({
      call: AssertObjectSchema.optional()
    }).optional()
  }).optional()
});
var ClientCapabilitiesSchema = object2({
  /**
   * Experimental, non-standard capabilities that the client supports.
   */
  experimental: record(string2(), AssertObjectSchema).optional(),
  /**
   * Present if the client supports sampling from an LLM.
   */
  sampling: object2({
    /**
     * Present if the client supports context inclusion via includeContext parameter.
     * If not declared, servers SHOULD only use `includeContext: "none"` (or omit it).
     */
    context: AssertObjectSchema.optional(),
    /**
     * Present if the client supports tool use via tools and toolChoice parameters.
     */
    tools: AssertObjectSchema.optional()
  }).optional(),
  /**
   * Present if the client supports eliciting user input.
   */
  elicitation: ElicitationCapabilitySchema.optional(),
  /**
   * Present if the client supports listing roots.
   */
  roots: object2({
    /**
     * Whether the client supports issuing notifications for changes to the roots list.
     */
    listChanged: boolean2().optional()
  }).optional(),
  /**
   * Present if the client supports task creation.
   */
  tasks: ClientTasksCapabilitySchema.optional(),
  /**
   * Extensions that the client supports. Keys are extension identifiers (vendor-prefix/extension-name).
   */
  extensions: record(string2(), AssertObjectSchema).optional()
});
var InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
   */
  protocolVersion: string2(),
  capabilities: ClientCapabilitiesSchema,
  clientInfo: ImplementationSchema
});
var InitializeRequestSchema = RequestSchema.extend({
  method: literal("initialize"),
  params: InitializeRequestParamsSchema
});
var ServerCapabilitiesSchema = object2({
  /**
   * Experimental, non-standard capabilities that the server supports.
   */
  experimental: record(string2(), AssertObjectSchema).optional(),
  /**
   * Present if the server supports sending log messages to the client.
   */
  logging: AssertObjectSchema.optional(),
  /**
   * Present if the server supports sending completions to the client.
   */
  completions: AssertObjectSchema.optional(),
  /**
   * Present if the server offers any prompt templates.
   */
  prompts: object2({
    /**
     * Whether this server supports issuing notifications for changes to the prompt list.
     */
    listChanged: boolean2().optional()
  }).optional(),
  /**
   * Present if the server offers any resources to read.
   */
  resources: object2({
    /**
     * Whether this server supports clients subscribing to resource updates.
     */
    subscribe: boolean2().optional(),
    /**
     * Whether this server supports issuing notifications for changes to the resource list.
     */
    listChanged: boolean2().optional()
  }).optional(),
  /**
   * Present if the server offers any tools to call.
   */
  tools: object2({
    /**
     * Whether this server supports issuing notifications for changes to the tool list.
     */
    listChanged: boolean2().optional()
  }).optional(),
  /**
   * Present if the server supports task creation.
   */
  tasks: ServerTasksCapabilitySchema.optional(),
  /**
   * Extensions that the server supports. Keys are extension identifiers (vendor-prefix/extension-name).
   */
  extensions: record(string2(), AssertObjectSchema).optional()
});
var InitializeResultSchema = ResultSchema.extend({
  /**
   * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
   */
  protocolVersion: string2(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ImplementationSchema,
  /**
   * Instructions describing how to use the server and its features.
   *
   * This can be used by clients to improve the LLM's understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.
   */
  instructions: string2().optional()
});
var InitializedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/initialized"),
  params: NotificationsParamsSchema.optional()
});
var PingRequestSchema = RequestSchema.extend({
  method: literal("ping"),
  params: BaseRequestParamsSchema.optional()
});
var ProgressSchema = object2({
  /**
   * The progress thus far. This should increase every time progress is made, even if the total is unknown.
   */
  progress: number2(),
  /**
   * Total number of items to process (or total progress required), if known.
   */
  total: optional(number2()),
  /**
   * An optional message describing the current progress.
   */
  message: optional(string2())
});
var ProgressNotificationParamsSchema = object2({
  ...NotificationsParamsSchema.shape,
  ...ProgressSchema.shape,
  /**
   * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
   */
  progressToken: ProgressTokenSchema
});
var ProgressNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/progress"),
  params: ProgressNotificationParamsSchema
});
var PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * An opaque token representing the current pagination position.
   * If provided, the server should return results starting after this cursor.
   */
  cursor: CursorSchema.optional()
});
var PaginatedRequestSchema = RequestSchema.extend({
  params: PaginatedRequestParamsSchema.optional()
});
var PaginatedResultSchema = ResultSchema.extend({
  /**
   * An opaque token representing the pagination position after the last returned result.
   * If present, there may be more results available.
   */
  nextCursor: CursorSchema.optional()
});
var TaskStatusSchema = _enum(["working", "input_required", "completed", "failed", "cancelled"]);
var TaskSchema = object2({
  taskId: string2(),
  status: TaskStatusSchema,
  /**
   * Time in milliseconds to keep task results available after completion.
   * If null, the task has unlimited lifetime until manually cleaned up.
   */
  ttl: union([number2(), _null3()]),
  /**
   * ISO 8601 timestamp when the task was created.
   */
  createdAt: string2(),
  /**
   * ISO 8601 timestamp when the task was last updated.
   */
  lastUpdatedAt: string2(),
  pollInterval: optional(number2()),
  /**
   * Optional diagnostic message for failed tasks or other status information.
   */
  statusMessage: optional(string2())
});
var CreateTaskResultSchema = ResultSchema.extend({
  task: TaskSchema
});
var TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);
var TaskStatusNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/tasks/status"),
  params: TaskStatusNotificationParamsSchema
});
var GetTaskRequestSchema = RequestSchema.extend({
  method: literal("tasks/get"),
  params: BaseRequestParamsSchema.extend({
    taskId: string2()
  })
});
var GetTaskResultSchema = ResultSchema.merge(TaskSchema);
var GetTaskPayloadRequestSchema = RequestSchema.extend({
  method: literal("tasks/result"),
  params: BaseRequestParamsSchema.extend({
    taskId: string2()
  })
});
var GetTaskPayloadResultSchema = ResultSchema.loose();
var ListTasksRequestSchema = PaginatedRequestSchema.extend({
  method: literal("tasks/list")
});
var ListTasksResultSchema = PaginatedResultSchema.extend({
  tasks: array(TaskSchema)
});
var CancelTaskRequestSchema = RequestSchema.extend({
  method: literal("tasks/cancel"),
  params: BaseRequestParamsSchema.extend({
    taskId: string2()
  })
});
var CancelTaskResultSchema = ResultSchema.merge(TaskSchema);
var ResourceContentsSchema = object2({
  /**
   * The URI of this resource.
   */
  uri: string2(),
  /**
   * The MIME type of this resource, if known.
   */
  mimeType: optional(string2()),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var TextResourceContentsSchema = ResourceContentsSchema.extend({
  /**
   * The text of the item. This must only be set if the item can actually be represented as text (not binary data).
   */
  text: string2()
});
var Base64Schema = string2().refine((val) => {
  try {
    atob(val);
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid Base64 string" });
var BlobResourceContentsSchema = ResourceContentsSchema.extend({
  /**
   * A base64-encoded string representing the binary data of the item.
   */
  blob: Base64Schema
});
var RoleSchema = _enum(["user", "assistant"]);
var AnnotationsSchema = object2({
  /**
   * Intended audience(s) for the resource.
   */
  audience: array(RoleSchema).optional(),
  /**
   * Importance hint for the resource, from 0 (least) to 1 (most).
   */
  priority: number2().min(0).max(1).optional(),
  /**
   * ISO 8601 timestamp for the most recent modification.
   */
  lastModified: iso_exports.datetime({ offset: true }).optional()
});
var ResourceSchema = object2({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  /**
   * The URI of this resource.
   */
  uri: string2(),
  /**
   * A description of what this resource represents.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description: optional(string2()),
  /**
   * The MIME type of this resource, if known.
   */
  mimeType: optional(string2()),
  /**
   * The size of the raw resource content, in bytes (i.e., before base64 encoding or any tokenization), if known.
   *
   * This can be used by Hosts to display file sizes and estimate context window usage.
   */
  size: optional(number2()),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: optional(looseObject({}))
});
var ResourceTemplateSchema = object2({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  /**
   * A URI template (according to RFC 6570) that can be used to construct resource URIs.
   */
  uriTemplate: string2(),
  /**
   * A description of what this template is for.
   *
   * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
   */
  description: optional(string2()),
  /**
   * The MIME type for all resources that match this template. This should only be included if all resources matching this template have the same type.
   */
  mimeType: optional(string2()),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: optional(looseObject({}))
});
var ListResourcesRequestSchema = PaginatedRequestSchema.extend({
  method: literal("resources/list")
});
var ListResourcesResultSchema = PaginatedResultSchema.extend({
  resources: array(ResourceSchema)
});
var ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({
  method: literal("resources/templates/list")
});
var ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({
  resourceTemplates: array(ResourceTemplateSchema)
});
var ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
   *
   * @format uri
   */
  uri: string2()
});
var ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;
var ReadResourceRequestSchema = RequestSchema.extend({
  method: literal("resources/read"),
  params: ReadResourceRequestParamsSchema
});
var ReadResourceResultSchema = ResultSchema.extend({
  contents: array(union([TextResourceContentsSchema, BlobResourceContentsSchema]))
});
var ResourceListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/resources/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var SubscribeRequestSchema = RequestSchema.extend({
  method: literal("resources/subscribe"),
  params: SubscribeRequestParamsSchema
});
var UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var UnsubscribeRequestSchema = RequestSchema.extend({
  method: literal("resources/unsubscribe"),
  params: UnsubscribeRequestParamsSchema
});
var ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
  /**
   * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
   */
  uri: string2()
});
var ResourceUpdatedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/resources/updated"),
  params: ResourceUpdatedNotificationParamsSchema
});
var PromptArgumentSchema = object2({
  /**
   * The name of the argument.
   */
  name: string2(),
  /**
   * A human-readable description of the argument.
   */
  description: optional(string2()),
  /**
   * Whether this argument must be provided.
   */
  required: optional(boolean2())
});
var PromptSchema = object2({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  /**
   * An optional description of what this prompt provides
   */
  description: optional(string2()),
  /**
   * A list of arguments to use for templating the prompt.
   */
  arguments: optional(array(PromptArgumentSchema)),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: optional(looseObject({}))
});
var ListPromptsRequestSchema = PaginatedRequestSchema.extend({
  method: literal("prompts/list")
});
var ListPromptsResultSchema = PaginatedResultSchema.extend({
  prompts: array(PromptSchema)
});
var GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * The name of the prompt or prompt template.
   */
  name: string2(),
  /**
   * Arguments to use for templating the prompt.
   */
  arguments: record(string2(), string2()).optional()
});
var GetPromptRequestSchema = RequestSchema.extend({
  method: literal("prompts/get"),
  params: GetPromptRequestParamsSchema
});
var TextContentSchema = object2({
  type: literal("text"),
  /**
   * The text content of the message.
   */
  text: string2(),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var ImageContentSchema = object2({
  type: literal("image"),
  /**
   * The base64-encoded image data.
   */
  data: Base64Schema,
  /**
   * The MIME type of the image. Different providers may support different image types.
   */
  mimeType: string2(),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var AudioContentSchema = object2({
  type: literal("audio"),
  /**
   * The base64-encoded audio data.
   */
  data: Base64Schema,
  /**
   * The MIME type of the audio. Different providers may support different audio types.
   */
  mimeType: string2(),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var ToolUseContentSchema = object2({
  type: literal("tool_use"),
  /**
   * The name of the tool to invoke.
   * Must match a tool name from the request's tools array.
   */
  name: string2(),
  /**
   * Unique identifier for this tool call.
   * Used to correlate with ToolResultContent in subsequent messages.
   */
  id: string2(),
  /**
   * Arguments to pass to the tool.
   * Must conform to the tool's inputSchema.
   */
  input: record(string2(), unknown()),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var EmbeddedResourceSchema = object2({
  type: literal("resource"),
  resource: union([TextResourceContentsSchema, BlobResourceContentsSchema]),
  /**
   * Optional annotations for the client.
   */
  annotations: AnnotationsSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var ResourceLinkSchema = ResourceSchema.extend({
  type: literal("resource_link")
});
var ContentBlockSchema = union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema
]);
var PromptMessageSchema = object2({
  role: RoleSchema,
  content: ContentBlockSchema
});
var GetPromptResultSchema = ResultSchema.extend({
  /**
   * An optional description for the prompt.
   */
  description: string2().optional(),
  messages: array(PromptMessageSchema)
});
var PromptListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/prompts/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ToolAnnotationsSchema = object2({
  /**
   * A human-readable title for the tool.
   */
  title: string2().optional(),
  /**
   * If true, the tool does not modify its environment.
   *
   * Default: false
   */
  readOnlyHint: boolean2().optional(),
  /**
   * If true, the tool may perform destructive updates to its environment.
   * If false, the tool performs only additive updates.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: true
   */
  destructiveHint: boolean2().optional(),
  /**
   * If true, calling the tool repeatedly with the same arguments
   * will have no additional effect on the its environment.
   *
   * (This property is meaningful only when `readOnlyHint == false`)
   *
   * Default: false
   */
  idempotentHint: boolean2().optional(),
  /**
   * If true, this tool may interact with an "open world" of external
   * entities. If false, the tool's domain of interaction is closed.
   * For example, the world of a web search tool is open, whereas that
   * of a memory tool is not.
   *
   * Default: true
   */
  openWorldHint: boolean2().optional()
});
var ToolExecutionSchema = object2({
  /**
   * Indicates the tool's preference for task-augmented execution.
   * - "required": Clients MUST invoke the tool as a task
   * - "optional": Clients MAY invoke the tool as a task or normal request
   * - "forbidden": Clients MUST NOT attempt to invoke the tool as a task
   *
   * If not present, defaults to "forbidden".
   */
  taskSupport: _enum(["required", "optional", "forbidden"]).optional()
});
var ToolSchema = object2({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  /**
   * A human-readable description of the tool.
   */
  description: string2().optional(),
  /**
   * A JSON Schema 2020-12 object defining the expected parameters for the tool.
   * Must have type: 'object' at the root level per MCP spec.
   */
  inputSchema: object2({
    type: literal("object"),
    properties: record(string2(), AssertObjectSchema).optional(),
    required: array(string2()).optional()
  }).catchall(unknown()),
  /**
   * An optional JSON Schema 2020-12 object defining the structure of the tool's output
   * returned in the structuredContent field of a CallToolResult.
   * Must have type: 'object' at the root level per MCP spec.
   */
  outputSchema: object2({
    type: literal("object"),
    properties: record(string2(), AssertObjectSchema).optional(),
    required: array(string2()).optional()
  }).catchall(unknown()).optional(),
  /**
   * Optional additional tool information.
   */
  annotations: ToolAnnotationsSchema.optional(),
  /**
   * Execution-related properties for this tool.
   */
  execution: ToolExecutionSchema.optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var ListToolsRequestSchema = PaginatedRequestSchema.extend({
  method: literal("tools/list")
});
var ListToolsResultSchema = PaginatedResultSchema.extend({
  tools: array(ToolSchema)
});
var CallToolResultSchema = ResultSchema.extend({
  /**
   * A list of content objects that represent the result of the tool call.
   *
   * If the Tool does not define an outputSchema, this field MUST be present in the result.
   * For backwards compatibility, this field is always present, but it may be empty.
   */
  content: array(ContentBlockSchema).default([]),
  /**
   * An object containing structured tool output.
   *
   * If the Tool defines an outputSchema, this field MUST be present in the result, and contain a JSON object that matches the schema.
   */
  structuredContent: record(string2(), unknown()).optional(),
  /**
   * Whether the tool call ended in an error.
   *
   * If not set, this is assumed to be false (the call was successful).
   *
   * Any errors that originate from the tool SHOULD be reported inside the result
   * object, with `isError` set to true, _not_ as an MCP protocol-level error
   * response. Otherwise, the LLM would not be able to see that an error occurred
   * and self-correct.
   *
   * However, any errors in _finding_ the tool, an error indicating that the
   * server does not support tool calls, or any other exceptional conditions,
   * should be reported as an MCP error response.
   */
  isError: boolean2().optional()
});
var CompatibilityCallToolResultSchema = CallToolResultSchema.or(ResultSchema.extend({
  toolResult: unknown()
}));
var CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  /**
   * The name of the tool to call.
   */
  name: string2(),
  /**
   * Arguments to pass to the tool.
   */
  arguments: record(string2(), unknown()).optional()
});
var CallToolRequestSchema = RequestSchema.extend({
  method: literal("tools/call"),
  params: CallToolRequestParamsSchema
});
var ToolListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/tools/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ListChangedOptionsBaseSchema = object2({
  /**
   * If true, the list will be refreshed automatically when a list changed notification is received.
   * The callback will be called with the updated list.
   *
   * If false, the callback will be called with null items, allowing manual refresh.
   *
   * @default true
   */
  autoRefresh: boolean2().default(true),
  /**
   * Debounce time in milliseconds for list changed notification processing.
   *
   * Multiple notifications received within this timeframe will only trigger one refresh.
   * Set to 0 to disable debouncing.
   *
   * @default 300
   */
  debounceMs: number2().int().nonnegative().default(300)
});
var LoggingLevelSchema = _enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
var SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({
  /**
   * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/logging/message.
   */
  level: LoggingLevelSchema
});
var SetLevelRequestSchema = RequestSchema.extend({
  method: literal("logging/setLevel"),
  params: SetLevelRequestParamsSchema
});
var LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
  /**
   * The severity of this log message.
   */
  level: LoggingLevelSchema,
  /**
   * An optional name of the logger issuing this message.
   */
  logger: string2().optional(),
  /**
   * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
   */
  data: unknown()
});
var LoggingMessageNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/message"),
  params: LoggingMessageNotificationParamsSchema
});
var ModelHintSchema = object2({
  /**
   * A hint for a model name.
   */
  name: string2().optional()
});
var ModelPreferencesSchema = object2({
  /**
   * Optional hints to use for model selection.
   */
  hints: array(ModelHintSchema).optional(),
  /**
   * How much to prioritize cost when selecting a model.
   */
  costPriority: number2().min(0).max(1).optional(),
  /**
   * How much to prioritize sampling speed (latency) when selecting a model.
   */
  speedPriority: number2().min(0).max(1).optional(),
  /**
   * How much to prioritize intelligence and capabilities when selecting a model.
   */
  intelligencePriority: number2().min(0).max(1).optional()
});
var ToolChoiceSchema = object2({
  /**
   * Controls when tools are used:
   * - "auto": Model decides whether to use tools (default)
   * - "required": Model MUST use at least one tool before completing
   * - "none": Model MUST NOT use any tools
   */
  mode: _enum(["auto", "required", "none"]).optional()
});
var ToolResultContentSchema = object2({
  type: literal("tool_result"),
  toolUseId: string2().describe("The unique identifier for the corresponding tool call."),
  content: array(ContentBlockSchema).default([]),
  structuredContent: object2({}).loose().optional(),
  isError: boolean2().optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var SamplingContentSchema = discriminatedUnion("type", [TextContentSchema, ImageContentSchema, AudioContentSchema]);
var SamplingMessageContentBlockSchema = discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema
]);
var SamplingMessageSchema = object2({
  role: RoleSchema,
  content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)]),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  messages: array(SamplingMessageSchema),
  /**
   * The server's preferences for which model to select. The client MAY modify or omit this request.
   */
  modelPreferences: ModelPreferencesSchema.optional(),
  /**
   * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
   */
  systemPrompt: string2().optional(),
  /**
   * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt.
   * The client MAY ignore this request.
   *
   * Default is "none". Values "thisServer" and "allServers" are soft-deprecated. Servers SHOULD only use these values if the client
   * declares ClientCapabilities.sampling.context. These values may be removed in future spec releases.
   */
  includeContext: _enum(["none", "thisServer", "allServers"]).optional(),
  temperature: number2().optional(),
  /**
   * The requested maximum number of tokens to sample (to prevent runaway completions).
   *
   * The client MAY choose to sample fewer tokens than the requested maximum.
   */
  maxTokens: number2().int(),
  stopSequences: array(string2()).optional(),
  /**
   * Optional metadata to pass through to the LLM provider. The format of this metadata is provider-specific.
   */
  metadata: AssertObjectSchema.optional(),
  /**
   * Tools that the model may use during generation.
   * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
   */
  tools: array(ToolSchema).optional(),
  /**
   * Controls how the model uses tools.
   * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
   * Default is `{ mode: "auto" }`.
   */
  toolChoice: ToolChoiceSchema.optional()
});
var CreateMessageRequestSchema = RequestSchema.extend({
  method: literal("sampling/createMessage"),
  params: CreateMessageRequestParamsSchema
});
var CreateMessageResultSchema = ResultSchema.extend({
  /**
   * The name of the model that generated the message.
   */
  model: string2(),
  /**
   * The reason why sampling stopped, if known.
   *
   * Standard values:
   * - "endTurn": Natural end of the assistant's turn
   * - "stopSequence": A stop sequence was encountered
   * - "maxTokens": Maximum token limit was reached
   *
   * This field is an open string to allow for provider-specific stop reasons.
   */
  stopReason: optional(_enum(["endTurn", "stopSequence", "maxTokens"]).or(string2())),
  role: RoleSchema,
  /**
   * Response content. Single content block (text, image, or audio).
   */
  content: SamplingContentSchema
});
var CreateMessageResultWithToolsSchema = ResultSchema.extend({
  /**
   * The name of the model that generated the message.
   */
  model: string2(),
  /**
   * The reason why sampling stopped, if known.
   *
   * Standard values:
   * - "endTurn": Natural end of the assistant's turn
   * - "stopSequence": A stop sequence was encountered
   * - "maxTokens": Maximum token limit was reached
   * - "toolUse": The model wants to use one or more tools
   *
   * This field is an open string to allow for provider-specific stop reasons.
   */
  stopReason: optional(_enum(["endTurn", "stopSequence", "maxTokens", "toolUse"]).or(string2())),
  role: RoleSchema,
  /**
   * Response content. May be a single block or array. May include ToolUseContent if stopReason is "toolUse".
   */
  content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)])
});
var BooleanSchemaSchema = object2({
  type: literal("boolean"),
  title: string2().optional(),
  description: string2().optional(),
  default: boolean2().optional()
});
var StringSchemaSchema = object2({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  minLength: number2().optional(),
  maxLength: number2().optional(),
  format: _enum(["email", "uri", "date", "date-time"]).optional(),
  default: string2().optional()
});
var NumberSchemaSchema = object2({
  type: _enum(["number", "integer"]),
  title: string2().optional(),
  description: string2().optional(),
  minimum: number2().optional(),
  maximum: number2().optional(),
  default: number2().optional()
});
var UntitledSingleSelectEnumSchemaSchema = object2({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  enum: array(string2()),
  default: string2().optional()
});
var TitledSingleSelectEnumSchemaSchema = object2({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  oneOf: array(object2({
    const: string2(),
    title: string2()
  })),
  default: string2().optional()
});
var LegacyTitledEnumSchemaSchema = object2({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  enum: array(string2()),
  enumNames: array(string2()).optional(),
  default: string2().optional()
});
var SingleSelectEnumSchemaSchema = union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);
var UntitledMultiSelectEnumSchemaSchema = object2({
  type: literal("array"),
  title: string2().optional(),
  description: string2().optional(),
  minItems: number2().optional(),
  maxItems: number2().optional(),
  items: object2({
    type: literal("string"),
    enum: array(string2())
  }),
  default: array(string2()).optional()
});
var TitledMultiSelectEnumSchemaSchema = object2({
  type: literal("array"),
  title: string2().optional(),
  description: string2().optional(),
  minItems: number2().optional(),
  maxItems: number2().optional(),
  items: object2({
    anyOf: array(object2({
      const: string2(),
      title: string2()
    }))
  }),
  default: array(string2()).optional()
});
var MultiSelectEnumSchemaSchema = union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);
var EnumSchemaSchema = union([LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema]);
var PrimitiveSchemaDefinitionSchema = union([EnumSchemaSchema, BooleanSchemaSchema, StringSchemaSchema, NumberSchemaSchema]);
var ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  /**
   * The elicitation mode.
   *
   * Optional for backward compatibility. Clients MUST treat missing mode as "form".
   */
  mode: literal("form").optional(),
  /**
   * The message to present to the user describing what information is being requested.
   */
  message: string2(),
  /**
   * A restricted subset of JSON Schema.
   * Only top-level properties are allowed, without nesting.
   */
  requestedSchema: object2({
    type: literal("object"),
    properties: record(string2(), PrimitiveSchemaDefinitionSchema),
    required: array(string2()).optional()
  })
});
var ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  /**
   * The elicitation mode.
   */
  mode: literal("url"),
  /**
   * The message to present to the user explaining why the interaction is needed.
   */
  message: string2(),
  /**
   * The ID of the elicitation, which must be unique within the context of the server.
   * The client MUST treat this ID as an opaque value.
   */
  elicitationId: string2(),
  /**
   * The URL that the user should navigate to.
   */
  url: string2().url()
});
var ElicitRequestParamsSchema = union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);
var ElicitRequestSchema = RequestSchema.extend({
  method: literal("elicitation/create"),
  params: ElicitRequestParamsSchema
});
var ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({
  /**
   * The ID of the elicitation that completed.
   */
  elicitationId: string2()
});
var ElicitationCompleteNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/elicitation/complete"),
  params: ElicitationCompleteNotificationParamsSchema
});
var ElicitResultSchema = ResultSchema.extend({
  /**
   * The user action in response to the elicitation.
   * - "accept": User submitted the form/confirmed the action
   * - "decline": User explicitly decline the action
   * - "cancel": User dismissed without making an explicit choice
   */
  action: _enum(["accept", "decline", "cancel"]),
  /**
   * The submitted form data, only present when action is "accept".
   * Contains values matching the requested schema.
   * Per MCP spec, content is "typically omitted" for decline/cancel actions.
   * We normalize null to undefined for leniency while maintaining type compatibility.
   */
  content: preprocess((val) => val === null ? void 0 : val, record(string2(), union([string2(), number2(), boolean2(), array(string2())])).optional())
});
var ResourceTemplateReferenceSchema = object2({
  type: literal("ref/resource"),
  /**
   * The URI or URI template of the resource.
   */
  uri: string2()
});
var PromptReferenceSchema = object2({
  type: literal("ref/prompt"),
  /**
   * The name of the prompt or prompt template
   */
  name: string2()
});
var CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
  ref: union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
  /**
   * The argument's information
   */
  argument: object2({
    /**
     * The name of the argument
     */
    name: string2(),
    /**
     * The value of the argument to use for completion matching.
     */
    value: string2()
  }),
  context: object2({
    /**
     * Previously-resolved variables in a URI template or prompt.
     */
    arguments: record(string2(), string2()).optional()
  }).optional()
});
var CompleteRequestSchema = RequestSchema.extend({
  method: literal("completion/complete"),
  params: CompleteRequestParamsSchema
});
var CompleteResultSchema = ResultSchema.extend({
  completion: looseObject({
    /**
     * An array of completion values. Must not exceed 100 items.
     */
    values: array(string2()).max(100),
    /**
     * The total number of completion options available. This can exceed the number of values actually sent in the response.
     */
    total: optional(number2().int()),
    /**
     * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
     */
    hasMore: optional(boolean2())
  })
});
var RootSchema = object2({
  /**
   * The URI identifying the root. This *must* start with file:// for now.
   */
  uri: string2().startsWith("file://"),
  /**
   * An optional name for the root.
   */
  name: string2().optional(),
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on _meta usage.
   */
  _meta: record(string2(), unknown()).optional()
});
var ListRootsRequestSchema = RequestSchema.extend({
  method: literal("roots/list"),
  params: BaseRequestParamsSchema.optional()
});
var ListRootsResultSchema = ResultSchema.extend({
  roots: array(RootSchema)
});
var RootsListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/roots/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ClientRequestSchema = union([
  PingRequestSchema,
  InitializeRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema
]);
var ClientNotificationSchema = union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
  TaskStatusNotificationSchema
]);
var ClientResultSchema = union([
  EmptyResultSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ListRootsResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  CreateTaskResultSchema
]);
var ServerRequestSchema = union([
  PingRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema
]);
var ServerNotificationSchema = union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  TaskStatusNotificationSchema,
  ElicitationCompleteNotificationSchema
]);
var ServerResultSchema = union([
  EmptyResultSchema,
  InitializeResultSchema,
  CompleteResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
  ListToolsResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  CreateTaskResultSchema
]);
var McpError = class _McpError extends Error {
  constructor(code, message, data) {
    super(`MCP error ${code}: ${message}`);
    this.code = code;
    this.data = data;
    this.name = "McpError";
  }
  /**
   * Factory method to create the appropriate error type based on the error code and data
   */
  static fromError(code, message, data) {
    if (code === ErrorCode.UrlElicitationRequired && data) {
      const errorData = data;
      if (errorData.elicitations) {
        return new UrlElicitationRequiredError(errorData.elicitations, message);
      }
    }
    return new _McpError(code, message, data);
  }
};
var UrlElicitationRequiredError = class extends McpError {
  constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? "s" : ""} required`) {
    super(ErrorCode.UrlElicitationRequired, message, {
      elicitations
    });
  }
  get elicitations() {
    return this.data?.elicitations ?? [];
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/interfaces.js
function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

// node_modules/zod-to-json-schema/dist/esm/parsers/string.js
var ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js
function getMethodLiteral(schema) {
  const shape = getObjectShape(schema);
  const methodSchema = shape?.method;
  if (!methodSchema) {
    throw new Error("Schema is missing a method literal");
  }
  const value = getLiteralValue(methodSchema);
  if (typeof value !== "string") {
    throw new Error("Schema method literal must be a string");
  }
  return value;
}
function parseWithCompat(schema, data) {
  const result = safeParse2(schema, data);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

// node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
var DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4;
var Protocol = class {
  constructor(_options) {
    this._options = _options;
    this._requestMessageId = 0;
    this._requestHandlers = /* @__PURE__ */ new Map();
    this._requestHandlerAbortControllers = /* @__PURE__ */ new Map();
    this._notificationHandlers = /* @__PURE__ */ new Map();
    this._responseHandlers = /* @__PURE__ */ new Map();
    this._progressHandlers = /* @__PURE__ */ new Map();
    this._timeoutInfo = /* @__PURE__ */ new Map();
    this._pendingDebouncedNotifications = /* @__PURE__ */ new Set();
    this._taskProgressTokens = /* @__PURE__ */ new Map();
    this._requestResolvers = /* @__PURE__ */ new Map();
    this.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      this._oncancel(notification);
    });
    this.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      this._onprogress(notification);
    });
    this.setRequestHandler(
      PingRequestSchema,
      // Automatic pong by default.
      (_request) => ({})
    );
    this._taskStore = _options?.taskStore;
    this._taskMessageQueue = _options?.taskMessageQueue;
    if (this._taskStore) {
      this.setRequestHandler(GetTaskRequestSchema, async (request, extra) => {
        const task = await this._taskStore.getTask(request.params.taskId, extra.sessionId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
        }
        return {
          ...task
        };
      });
      this.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
        const handleTaskResult = async () => {
          const taskId = request.params.taskId;
          if (this._taskMessageQueue) {
            let queuedMessage;
            while (queuedMessage = await this._taskMessageQueue.dequeue(taskId, extra.sessionId)) {
              if (queuedMessage.type === "response" || queuedMessage.type === "error") {
                const message = queuedMessage.message;
                const requestId = message.id;
                const resolver = this._requestResolvers.get(requestId);
                if (resolver) {
                  this._requestResolvers.delete(requestId);
                  if (queuedMessage.type === "response") {
                    resolver(message);
                  } else {
                    const errorMessage = message;
                    const error2 = new McpError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
                    resolver(error2);
                  }
                } else {
                  const messageType = queuedMessage.type === "response" ? "Response" : "Error";
                  this._onerror(new Error(`${messageType} handler missing for request ${requestId}`));
                }
                continue;
              }
              await this._transport?.send(queuedMessage.message, { relatedRequestId: extra.requestId });
            }
          }
          const task = await this._taskStore.getTask(taskId, extra.sessionId);
          if (!task) {
            throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
          }
          if (!isTerminal(task.status)) {
            await this._waitForTaskUpdate(taskId, extra.signal);
            return await handleTaskResult();
          }
          if (isTerminal(task.status)) {
            const result = await this._taskStore.getTaskResult(taskId, extra.sessionId);
            this._clearTaskQueue(taskId);
            return {
              ...result,
              _meta: {
                ...result._meta,
                [RELATED_TASK_META_KEY]: {
                  taskId
                }
              }
            };
          }
          return await handleTaskResult();
        };
        return await handleTaskResult();
      });
      this.setRequestHandler(ListTasksRequestSchema, async (request, extra) => {
        try {
          const { tasks, nextCursor } = await this._taskStore.listTasks(request.params?.cursor, extra.sessionId);
          return {
            tasks,
            nextCursor,
            _meta: {}
          };
        } catch (error2) {
          throw new McpError(ErrorCode.InvalidParams, `Failed to list tasks: ${error2 instanceof Error ? error2.message : String(error2)}`);
        }
      });
      this.setRequestHandler(CancelTaskRequestSchema, async (request, extra) => {
        try {
          const task = await this._taskStore.getTask(request.params.taskId, extra.sessionId);
          if (!task) {
            throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
          }
          if (isTerminal(task.status)) {
            throw new McpError(ErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
          }
          await this._taskStore.updateTaskStatus(request.params.taskId, "cancelled", "Client cancelled task execution.", extra.sessionId);
          this._clearTaskQueue(request.params.taskId);
          const cancelledTask = await this._taskStore.getTask(request.params.taskId, extra.sessionId);
          if (!cancelledTask) {
            throw new McpError(ErrorCode.InvalidParams, `Task not found after cancellation: ${request.params.taskId}`);
          }
          return {
            _meta: {},
            ...cancelledTask
          };
        } catch (error2) {
          if (error2 instanceof McpError) {
            throw error2;
          }
          throw new McpError(ErrorCode.InvalidRequest, `Failed to cancel task: ${error2 instanceof Error ? error2.message : String(error2)}`);
        }
      });
    }
  }
  async _oncancel(notification) {
    if (!notification.params.requestId) {
      return;
    }
    const controller = this._requestHandlerAbortControllers.get(notification.params.requestId);
    controller?.abort(notification.params.reason);
  }
  _setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetTimeoutOnProgress = false) {
    this._timeoutInfo.set(messageId, {
      timeoutId: setTimeout(onTimeout, timeout),
      startTime: Date.now(),
      timeout,
      maxTotalTimeout,
      resetTimeoutOnProgress,
      onTimeout
    });
  }
  _resetTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (!info)
      return false;
    const totalElapsed = Date.now() - info.startTime;
    if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
      this._timeoutInfo.delete(messageId);
      throw McpError.fromError(ErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
        maxTotalTimeout: info.maxTotalTimeout,
        totalElapsed
      });
    }
    clearTimeout(info.timeoutId);
    info.timeoutId = setTimeout(info.onTimeout, info.timeout);
    return true;
  }
  _cleanupTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (info) {
      clearTimeout(info.timeoutId);
      this._timeoutInfo.delete(messageId);
    }
  }
  /**
   * Attaches to the given transport, starts it, and starts listening for messages.
   *
   * The Protocol object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
   */
  async connect(transport) {
    if (this._transport) {
      throw new Error("Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.");
    }
    this._transport = transport;
    const _onclose = this.transport?.onclose;
    this._transport.onclose = () => {
      _onclose?.();
      this._onclose();
    };
    const _onerror = this.transport?.onerror;
    this._transport.onerror = (error2) => {
      _onerror?.(error2);
      this._onerror(error2);
    };
    const _onmessage = this._transport?.onmessage;
    this._transport.onmessage = (message, extra) => {
      _onmessage?.(message, extra);
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        this._onresponse(message);
      } else if (isJSONRPCRequest(message)) {
        this._onrequest(message, extra);
      } else if (isJSONRPCNotification(message)) {
        this._onnotification(message);
      } else {
        this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
      }
    };
    await this._transport.start();
  }
  _onclose() {
    const responseHandlers = this._responseHandlers;
    this._responseHandlers = /* @__PURE__ */ new Map();
    this._progressHandlers.clear();
    this._taskProgressTokens.clear();
    this._pendingDebouncedNotifications.clear();
    for (const info of this._timeoutInfo.values()) {
      clearTimeout(info.timeoutId);
    }
    this._timeoutInfo.clear();
    for (const controller of this._requestHandlerAbortControllers.values()) {
      controller.abort();
    }
    this._requestHandlerAbortControllers.clear();
    const error2 = McpError.fromError(ErrorCode.ConnectionClosed, "Connection closed");
    this._transport = void 0;
    this.onclose?.();
    for (const handler of responseHandlers.values()) {
      handler(error2);
    }
  }
  _onerror(error2) {
    this.onerror?.(error2);
  }
  _onnotification(notification) {
    const handler = this._notificationHandlers.get(notification.method) ?? this.fallbackNotificationHandler;
    if (handler === void 0) {
      return;
    }
    Promise.resolve().then(() => handler(notification)).catch((error2) => this._onerror(new Error(`Uncaught error in notification handler: ${error2}`)));
  }
  _onrequest(request, extra) {
    const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;
    const capturedTransport = this._transport;
    const relatedTaskId = request.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;
    if (handler === void 0) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: ErrorCode.MethodNotFound,
          message: "Method not found"
        }
      };
      if (relatedTaskId && this._taskMessageQueue) {
        this._enqueueTaskMessage(relatedTaskId, {
          type: "error",
          message: errorResponse,
          timestamp: Date.now()
        }, capturedTransport?.sessionId).catch((error2) => this._onerror(new Error(`Failed to enqueue error response: ${error2}`)));
      } else {
        capturedTransport?.send(errorResponse).catch((error2) => this._onerror(new Error(`Failed to send an error response: ${error2}`)));
      }
      return;
    }
    const abortController = new AbortController();
    this._requestHandlerAbortControllers.set(request.id, abortController);
    const taskCreationParams = isTaskAugmentedRequestParams(request.params) ? request.params.task : void 0;
    const taskStore = this._taskStore ? this.requestTaskStore(request, capturedTransport?.sessionId) : void 0;
    const fullExtra = {
      signal: abortController.signal,
      sessionId: capturedTransport?.sessionId,
      _meta: request.params?._meta,
      sendNotification: async (notification) => {
        if (abortController.signal.aborted)
          return;
        const notificationOptions = { relatedRequestId: request.id };
        if (relatedTaskId) {
          notificationOptions.relatedTask = { taskId: relatedTaskId };
        }
        await this.notification(notification, notificationOptions);
      },
      sendRequest: async (r, resultSchema, options) => {
        if (abortController.signal.aborted) {
          throw new McpError(ErrorCode.ConnectionClosed, "Request was cancelled");
        }
        const requestOptions = { ...options, relatedRequestId: request.id };
        if (relatedTaskId && !requestOptions.relatedTask) {
          requestOptions.relatedTask = { taskId: relatedTaskId };
        }
        const effectiveTaskId = requestOptions.relatedTask?.taskId ?? relatedTaskId;
        if (effectiveTaskId && taskStore) {
          await taskStore.updateTaskStatus(effectiveTaskId, "input_required");
        }
        return await this.request(r, resultSchema, requestOptions);
      },
      authInfo: extra?.authInfo,
      requestId: request.id,
      requestInfo: extra?.requestInfo,
      taskId: relatedTaskId,
      taskStore,
      taskRequestedTtl: taskCreationParams?.ttl,
      closeSSEStream: extra?.closeSSEStream,
      closeStandaloneSSEStream: extra?.closeStandaloneSSEStream
    };
    Promise.resolve().then(() => {
      if (taskCreationParams) {
        this.assertTaskHandlerCapability(request.method);
      }
    }).then(() => handler(request, fullExtra)).then(async (result) => {
      if (abortController.signal.aborted) {
        return;
      }
      const response = {
        result,
        jsonrpc: "2.0",
        id: request.id
      };
      if (relatedTaskId && this._taskMessageQueue) {
        await this._enqueueTaskMessage(relatedTaskId, {
          type: "response",
          message: response,
          timestamp: Date.now()
        }, capturedTransport?.sessionId);
      } else {
        await capturedTransport?.send(response);
      }
    }, async (error2) => {
      if (abortController.signal.aborted) {
        return;
      }
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: Number.isSafeInteger(error2["code"]) ? error2["code"] : ErrorCode.InternalError,
          message: error2.message ?? "Internal error",
          ...error2["data"] !== void 0 && { data: error2["data"] }
        }
      };
      if (relatedTaskId && this._taskMessageQueue) {
        await this._enqueueTaskMessage(relatedTaskId, {
          type: "error",
          message: errorResponse,
          timestamp: Date.now()
        }, capturedTransport?.sessionId);
      } else {
        await capturedTransport?.send(errorResponse);
      }
    }).catch((error2) => this._onerror(new Error(`Failed to send response: ${error2}`))).finally(() => {
      if (this._requestHandlerAbortControllers.get(request.id) === abortController) {
        this._requestHandlerAbortControllers.delete(request.id);
      }
    });
  }
  _onprogress(notification) {
    const { progressToken, ...params } = notification.params;
    const messageId = Number(progressToken);
    const handler = this._progressHandlers.get(messageId);
    if (!handler) {
      this._onerror(new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
      return;
    }
    const responseHandler = this._responseHandlers.get(messageId);
    const timeoutInfo = this._timeoutInfo.get(messageId);
    if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) {
      try {
        this._resetTimeout(messageId);
      } catch (error2) {
        this._responseHandlers.delete(messageId);
        this._progressHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        responseHandler(error2);
        return;
      }
    }
    handler(params);
  }
  _onresponse(response) {
    const messageId = Number(response.id);
    const resolver = this._requestResolvers.get(messageId);
    if (resolver) {
      this._requestResolvers.delete(messageId);
      if (isJSONRPCResultResponse(response)) {
        resolver(response);
      } else {
        const error2 = new McpError(response.error.code, response.error.message, response.error.data);
        resolver(error2);
      }
      return;
    }
    const handler = this._responseHandlers.get(messageId);
    if (handler === void 0) {
      this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
      return;
    }
    this._responseHandlers.delete(messageId);
    this._cleanupTimeout(messageId);
    let isTaskResponse = false;
    if (isJSONRPCResultResponse(response) && response.result && typeof response.result === "object") {
      const result = response.result;
      if (result.task && typeof result.task === "object") {
        const task = result.task;
        if (typeof task.taskId === "string") {
          isTaskResponse = true;
          this._taskProgressTokens.set(task.taskId, messageId);
        }
      }
    }
    if (!isTaskResponse) {
      this._progressHandlers.delete(messageId);
    }
    if (isJSONRPCResultResponse(response)) {
      handler(response);
    } else {
      const error2 = McpError.fromError(response.error.code, response.error.message, response.error.data);
      handler(error2);
    }
  }
  get transport() {
    return this._transport;
  }
  /**
   * Closes the connection.
   */
  async close() {
    await this._transport?.close();
  }
  /**
   * Sends a request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * @example
   * ```typescript
   * const stream = protocol.requestStream(request, resultSchema, options);
   * for await (const message of stream) {
   *   switch (message.type) {
   *     case 'taskCreated':
   *       console.log('Task created:', message.task.taskId);
   *       break;
   *     case 'taskStatus':
   *       console.log('Task status:', message.task.status);
   *       break;
   *     case 'result':
   *       console.log('Final result:', message.result);
   *       break;
   *     case 'error':
   *       console.error('Error:', message.error);
   *       break;
   *   }
   * }
   * ```
   *
   * @experimental Use `client.experimental.tasks.requestStream()` to access this method.
   */
  async *requestStream(request, resultSchema, options) {
    const { task } = options ?? {};
    if (!task) {
      try {
        const result = await this.request(request, resultSchema, options);
        yield { type: "result", result };
      } catch (error2) {
        yield {
          type: "error",
          error: error2 instanceof McpError ? error2 : new McpError(ErrorCode.InternalError, String(error2))
        };
      }
      return;
    }
    let taskId;
    try {
      const createResult = await this.request(request, CreateTaskResultSchema, options);
      if (createResult.task) {
        taskId = createResult.task.taskId;
        yield { type: "taskCreated", task: createResult.task };
      } else {
        throw new McpError(ErrorCode.InternalError, "Task creation did not return a task");
      }
      while (true) {
        const task2 = await this.getTask({ taskId }, options);
        yield { type: "taskStatus", task: task2 };
        if (isTerminal(task2.status)) {
          if (task2.status === "completed") {
            const result = await this.getTaskResult({ taskId }, resultSchema, options);
            yield { type: "result", result };
          } else if (task2.status === "failed") {
            yield {
              type: "error",
              error: new McpError(ErrorCode.InternalError, `Task ${taskId} failed`)
            };
          } else if (task2.status === "cancelled") {
            yield {
              type: "error",
              error: new McpError(ErrorCode.InternalError, `Task ${taskId} was cancelled`)
            };
          }
          return;
        }
        if (task2.status === "input_required") {
          const result = await this.getTaskResult({ taskId }, resultSchema, options);
          yield { type: "result", result };
          return;
        }
        const pollInterval = task2.pollInterval ?? this._options?.defaultTaskPollInterval ?? 1e3;
        await new Promise((resolve6) => setTimeout(resolve6, pollInterval));
        options?.signal?.throwIfAborted();
      }
    } catch (error2) {
      yield {
        type: "error",
        error: error2 instanceof McpError ? error2 : new McpError(ErrorCode.InternalError, String(error2))
      };
    }
  }
  /**
   * Sends a request and waits for a response.
   *
   * Do not use this method to emit notifications! Use notification() instead.
   */
  request(request, resultSchema, options) {
    const { relatedRequestId, resumptionToken, onresumptiontoken, task, relatedTask } = options ?? {};
    return new Promise((resolve6, reject2) => {
      const earlyReject = (error2) => {
        reject2(error2);
      };
      if (!this._transport) {
        earlyReject(new Error("Not connected"));
        return;
      }
      if (this._options?.enforceStrictCapabilities === true) {
        try {
          this.assertCapabilityForMethod(request.method);
          if (task) {
            this.assertTaskCapability(request.method);
          }
        } catch (e) {
          earlyReject(e);
          return;
        }
      }
      options?.signal?.throwIfAborted();
      const messageId = this._requestMessageId++;
      const jsonrpcRequest = {
        ...request,
        jsonrpc: "2.0",
        id: messageId
      };
      if (options?.onprogress) {
        this._progressHandlers.set(messageId, options.onprogress);
        jsonrpcRequest.params = {
          ...request.params,
          _meta: {
            ...request.params?._meta || {},
            progressToken: messageId
          }
        };
      }
      if (task) {
        jsonrpcRequest.params = {
          ...jsonrpcRequest.params,
          task
        };
      }
      if (relatedTask) {
        jsonrpcRequest.params = {
          ...jsonrpcRequest.params,
          _meta: {
            ...jsonrpcRequest.params?._meta || {},
            [RELATED_TASK_META_KEY]: relatedTask
          }
        };
      }
      const cancel = (reason) => {
        this._responseHandlers.delete(messageId);
        this._progressHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        this._transport?.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: {
            requestId: messageId,
            reason: String(reason)
          }
        }, { relatedRequestId, resumptionToken, onresumptiontoken }).catch((error3) => this._onerror(new Error(`Failed to send cancellation: ${error3}`)));
        const error2 = reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason));
        reject2(error2);
      };
      this._responseHandlers.set(messageId, (response) => {
        if (options?.signal?.aborted) {
          return;
        }
        if (response instanceof Error) {
          return reject2(response);
        }
        try {
          const parseResult = safeParse2(resultSchema, response.result);
          if (!parseResult.success) {
            reject2(parseResult.error);
          } else {
            resolve6(parseResult.data);
          }
        } catch (error2) {
          reject2(error2);
        }
      });
      options?.signal?.addEventListener("abort", () => {
        cancel(options?.signal?.reason);
      });
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
      const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, "Request timed out", { timeout }));
      this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
      const relatedTaskId = relatedTask?.taskId;
      if (relatedTaskId) {
        const responseResolver = (response) => {
          const handler = this._responseHandlers.get(messageId);
          if (handler) {
            handler(response);
          } else {
            this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
          }
        };
        this._requestResolvers.set(messageId, responseResolver);
        this._enqueueTaskMessage(relatedTaskId, {
          type: "request",
          message: jsonrpcRequest,
          timestamp: Date.now()
        }).catch((error2) => {
          this._cleanupTimeout(messageId);
          reject2(error2);
        });
      } else {
        this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch((error2) => {
          this._cleanupTimeout(messageId);
          reject2(error2);
        });
      }
    });
  }
  /**
   * Gets the current status of a task.
   *
   * @experimental Use `client.experimental.tasks.getTask()` to access this method.
   */
  async getTask(params, options) {
    return this.request({ method: "tasks/get", params }, GetTaskResultSchema, options);
  }
  /**
   * Retrieves the result of a completed task.
   *
   * @experimental Use `client.experimental.tasks.getTaskResult()` to access this method.
   */
  async getTaskResult(params, resultSchema, options) {
    return this.request({ method: "tasks/result", params }, resultSchema, options);
  }
  /**
   * Lists tasks, optionally starting from a pagination cursor.
   *
   * @experimental Use `client.experimental.tasks.listTasks()` to access this method.
   */
  async listTasks(params, options) {
    return this.request({ method: "tasks/list", params }, ListTasksResultSchema, options);
  }
  /**
   * Cancels a specific task.
   *
   * @experimental Use `client.experimental.tasks.cancelTask()` to access this method.
   */
  async cancelTask(params, options) {
    return this.request({ method: "tasks/cancel", params }, CancelTaskResultSchema, options);
  }
  /**
   * Emits a notification, which is a one-way message that does not expect a response.
   */
  async notification(notification, options) {
    if (!this._transport) {
      throw new Error("Not connected");
    }
    this.assertNotificationCapability(notification.method);
    const relatedTaskId = options?.relatedTask?.taskId;
    if (relatedTaskId) {
      const jsonrpcNotification2 = {
        ...notification,
        jsonrpc: "2.0",
        params: {
          ...notification.params,
          _meta: {
            ...notification.params?._meta || {},
            [RELATED_TASK_META_KEY]: options.relatedTask
          }
        }
      };
      await this._enqueueTaskMessage(relatedTaskId, {
        type: "notification",
        message: jsonrpcNotification2,
        timestamp: Date.now()
      });
      return;
    }
    const debouncedMethods = this._options?.debouncedNotificationMethods ?? [];
    const canDebounce = debouncedMethods.includes(notification.method) && !notification.params && !options?.relatedRequestId && !options?.relatedTask;
    if (canDebounce) {
      if (this._pendingDebouncedNotifications.has(notification.method)) {
        return;
      }
      this._pendingDebouncedNotifications.add(notification.method);
      Promise.resolve().then(() => {
        this._pendingDebouncedNotifications.delete(notification.method);
        if (!this._transport) {
          return;
        }
        let jsonrpcNotification2 = {
          ...notification,
          jsonrpc: "2.0"
        };
        if (options?.relatedTask) {
          jsonrpcNotification2 = {
            ...jsonrpcNotification2,
            params: {
              ...jsonrpcNotification2.params,
              _meta: {
                ...jsonrpcNotification2.params?._meta || {},
                [RELATED_TASK_META_KEY]: options.relatedTask
              }
            }
          };
        }
        this._transport?.send(jsonrpcNotification2, options).catch((error2) => this._onerror(error2));
      });
      return;
    }
    let jsonrpcNotification = {
      ...notification,
      jsonrpc: "2.0"
    };
    if (options?.relatedTask) {
      jsonrpcNotification = {
        ...jsonrpcNotification,
        params: {
          ...jsonrpcNotification.params,
          _meta: {
            ...jsonrpcNotification.params?._meta || {},
            [RELATED_TASK_META_KEY]: options.relatedTask
          }
        }
      };
    }
    await this._transport.send(jsonrpcNotification, options);
  }
  /**
   * Registers a handler to invoke when this protocol object receives a request with the given method.
   *
   * Note that this will replace any previous request handler for the same method.
   */
  setRequestHandler(requestSchema, handler) {
    const method = getMethodLiteral(requestSchema);
    this.assertRequestHandlerCapability(method);
    this._requestHandlers.set(method, (request, extra) => {
      const parsed = parseWithCompat(requestSchema, request);
      return Promise.resolve(handler(parsed, extra));
    });
  }
  /**
   * Removes the request handler for the given method.
   */
  removeRequestHandler(method) {
    this._requestHandlers.delete(method);
  }
  /**
   * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
   */
  assertCanSetRequestHandler(method) {
    if (this._requestHandlers.has(method)) {
      throw new Error(`A request handler for ${method} already exists, which would be overridden`);
    }
  }
  /**
   * Registers a handler to invoke when this protocol object receives a notification with the given method.
   *
   * Note that this will replace any previous notification handler for the same method.
   */
  setNotificationHandler(notificationSchema, handler) {
    const method = getMethodLiteral(notificationSchema);
    this._notificationHandlers.set(method, (notification) => {
      const parsed = parseWithCompat(notificationSchema, notification);
      return Promise.resolve(handler(parsed));
    });
  }
  /**
   * Removes the notification handler for the given method.
   */
  removeNotificationHandler(method) {
    this._notificationHandlers.delete(method);
  }
  /**
   * Cleans up the progress handler associated with a task.
   * This should be called when a task reaches a terminal status.
   */
  _cleanupTaskProgressHandler(taskId) {
    const progressToken = this._taskProgressTokens.get(taskId);
    if (progressToken !== void 0) {
      this._progressHandlers.delete(progressToken);
      this._taskProgressTokens.delete(taskId);
    }
  }
  /**
   * Enqueues a task-related message for side-channel delivery via tasks/result.
   * @param taskId The task ID to associate the message with
   * @param message The message to enqueue
   * @param sessionId Optional session ID for binding the operation to a specific session
   * @throws Error if taskStore is not configured or if enqueue fails (e.g., queue overflow)
   *
   * Note: If enqueue fails, it's the TaskMessageQueue implementation's responsibility to handle
   * the error appropriately (e.g., by failing the task, logging, etc.). The Protocol layer
   * simply propagates the error.
   */
  async _enqueueTaskMessage(taskId, message, sessionId) {
    if (!this._taskStore || !this._taskMessageQueue) {
      throw new Error("Cannot enqueue task message: taskStore and taskMessageQueue are not configured");
    }
    const maxQueueSize = this._options?.maxTaskQueueSize;
    await this._taskMessageQueue.enqueue(taskId, message, sessionId, maxQueueSize);
  }
  /**
   * Clears the message queue for a task and rejects any pending request resolvers.
   * @param taskId The task ID whose queue should be cleared
   * @param sessionId Optional session ID for binding the operation to a specific session
   */
  async _clearTaskQueue(taskId, sessionId) {
    if (this._taskMessageQueue) {
      const messages = await this._taskMessageQueue.dequeueAll(taskId, sessionId);
      for (const message of messages) {
        if (message.type === "request" && isJSONRPCRequest(message.message)) {
          const requestId = message.message.id;
          const resolver = this._requestResolvers.get(requestId);
          if (resolver) {
            resolver(new McpError(ErrorCode.InternalError, "Task cancelled or completed"));
            this._requestResolvers.delete(requestId);
          } else {
            this._onerror(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
          }
        }
      }
    }
  }
  /**
   * Waits for a task update (new messages or status change) with abort signal support.
   * Uses polling to check for updates at the task's configured poll interval.
   * @param taskId The task ID to wait for
   * @param signal Abort signal to cancel the wait
   * @returns Promise that resolves when an update occurs or rejects if aborted
   */
  async _waitForTaskUpdate(taskId, signal) {
    let interval = this._options?.defaultTaskPollInterval ?? 1e3;
    try {
      const task = await this._taskStore?.getTask(taskId);
      if (task?.pollInterval) {
        interval = task.pollInterval;
      }
    } catch {
    }
    return new Promise((resolve6, reject2) => {
      if (signal.aborted) {
        reject2(new McpError(ErrorCode.InvalidRequest, "Request cancelled"));
        return;
      }
      const timeoutId = setTimeout(resolve6, interval);
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        reject2(new McpError(ErrorCode.InvalidRequest, "Request cancelled"));
      }, { once: true });
    });
  }
  requestTaskStore(request, sessionId) {
    const taskStore = this._taskStore;
    if (!taskStore) {
      throw new Error("No task store configured");
    }
    return {
      createTask: async (taskParams) => {
        if (!request) {
          throw new Error("No request provided");
        }
        return await taskStore.createTask(taskParams, request.id, {
          method: request.method,
          params: request.params
        }, sessionId);
      },
      getTask: async (taskId) => {
        const task = await taskStore.getTask(taskId, sessionId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, "Failed to retrieve task: Task not found");
        }
        return task;
      },
      storeTaskResult: async (taskId, status, result) => {
        await taskStore.storeTaskResult(taskId, status, result, sessionId);
        const task = await taskStore.getTask(taskId, sessionId);
        if (task) {
          const notification = TaskStatusNotificationSchema.parse({
            method: "notifications/tasks/status",
            params: task
          });
          await this.notification(notification);
          if (isTerminal(task.status)) {
            this._cleanupTaskProgressHandler(taskId);
          }
        }
      },
      getTaskResult: (taskId) => {
        return taskStore.getTaskResult(taskId, sessionId);
      },
      updateTaskStatus: async (taskId, status, statusMessage) => {
        const task = await taskStore.getTask(taskId, sessionId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task "${taskId}" not found - it may have been cleaned up`);
        }
        if (isTerminal(task.status)) {
          throw new McpError(ErrorCode.InvalidParams, `Cannot update task "${taskId}" from terminal status "${task.status}" to "${status}". Terminal states (completed, failed, cancelled) cannot transition to other states.`);
        }
        await taskStore.updateTaskStatus(taskId, status, statusMessage, sessionId);
        const updatedTask = await taskStore.getTask(taskId, sessionId);
        if (updatedTask) {
          const notification = TaskStatusNotificationSchema.parse({
            method: "notifications/tasks/status",
            params: updatedTask
          });
          await this.notification(notification);
          if (isTerminal(updatedTask.status)) {
            this._cleanupTaskProgressHandler(taskId);
          }
        }
      },
      listTasks: (cursor) => {
        return taskStore.listTasks(cursor, sessionId);
      }
    };
  }
};
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeCapabilities(base, additional) {
  const result = { ...base };
  for (const key in additional) {
    const k = key;
    const addValue = additional[k];
    if (addValue === void 0)
      continue;
    const baseValue = result[k];
    if (isPlainObject2(baseValue) && isPlainObject2(addValue)) {
      result[k] = { ...baseValue, ...addValue };
    } else {
      result[k] = addValue;
    }
  }
  return result;
}

// node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js
var import_ajv = __toESM(require_ajv(), 1);
var import_ajv_formats = __toESM(require_dist(), 1);
function createDefaultAjvInstance() {
  const ajv = new import_ajv.default({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true
  });
  const addFormats = import_ajv_formats.default;
  addFormats(ajv);
  return ajv;
}
var AjvJsonSchemaValidator = class {
  /**
   * Create an AJV validator
   *
   * @param ajv - Optional pre-configured AJV instance. If not provided, a default instance will be created.
   *
   * @example
   * ```typescript
   * // Use default configuration (recommended for most cases)
   * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
   * const validator = new AjvJsonSchemaValidator();
   *
   * // Or provide custom AJV instance for advanced configuration
   * import { Ajv } from 'ajv';
   * import addFormats from 'ajv-formats';
   *
   * const ajv = new Ajv({ validateFormats: true });
   * addFormats(ajv);
   * const validator = new AjvJsonSchemaValidator(ajv);
   * ```
   */
  constructor(ajv) {
    this._ajv = ajv ?? createDefaultAjvInstance();
  }
  /**
   * Create a validator for the given JSON Schema
   *
   * The validator is compiled once and can be reused multiple times.
   * If the schema has an $id, it will be cached by AJV automatically.
   *
   * @param schema - Standard JSON Schema object
   * @returns A validator function that validates input data
   */
  getValidator(schema) {
    const ajvValidator = "$id" in schema && typeof schema.$id === "string" ? this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema) : this._ajv.compile(schema);
    return (input) => {
      const valid = ajvValidator(input);
      if (valid) {
        return {
          valid: true,
          data: input,
          errorMessage: void 0
        };
      } else {
        return {
          valid: false,
          data: void 0,
          errorMessage: this._ajv.errorsText(ajvValidator.errors)
        };
      }
    };
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/server.js
var ExperimentalServerTasks = class {
  constructor(_server) {
    this._server = _server;
  }
  /**
   * Sends a request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * This method provides streaming access to request processing, allowing you to
   * observe intermediate task status updates for task-augmented requests.
   *
   * @param request - The request to send
   * @param resultSchema - Zod schema for validating the result
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  requestStream(request, resultSchema, options) {
    return this._server.requestStream(request, resultSchema, options);
  }
  /**
   * Sends a sampling request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * For task-augmented requests, yields 'taskCreated' and 'taskStatus' messages
   * before the final result.
   *
   * @example
   * ```typescript
   * const stream = server.experimental.tasks.createMessageStream({
   *     messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
   *     maxTokens: 100
   * }, {
   *     onprogress: (progress) => {
   *         // Handle streaming tokens via progress notifications
   *         console.log('Progress:', progress.message);
   *     }
   * });
   *
   * for await (const message of stream) {
   *     switch (message.type) {
   *         case 'taskCreated':
   *             console.log('Task created:', message.task.taskId);
   *             break;
   *         case 'taskStatus':
   *             console.log('Task status:', message.task.status);
   *             break;
   *         case 'result':
   *             console.log('Final result:', message.result);
   *             break;
   *         case 'error':
   *             console.error('Error:', message.error);
   *             break;
   *     }
   * }
   * ```
   *
   * @param params - The sampling request parameters
   * @param options - Optional request options (timeout, signal, task creation params, onprogress, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  createMessageStream(params, options) {
    const clientCapabilities = this._server.getClientCapabilities();
    if ((params.tools || params.toolChoice) && !clientCapabilities?.sampling?.tools) {
      throw new Error("Client does not support sampling tools capability.");
    }
    if (params.messages.length > 0) {
      const lastMessage = params.messages[params.messages.length - 1];
      const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
      const hasToolResults = lastContent.some((c) => c.type === "tool_result");
      const previousMessage = params.messages.length > 1 ? params.messages[params.messages.length - 2] : void 0;
      const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
      const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
      if (hasToolResults) {
        if (lastContent.some((c) => c.type !== "tool_result")) {
          throw new Error("The last message must contain only tool_result content if any is present");
        }
        if (!hasPreviousToolUse) {
          throw new Error("tool_result blocks are not matching any tool_use from the previous message");
        }
      }
      if (hasPreviousToolUse) {
        const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
        const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
        if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) {
          throw new Error("ids of tool_result blocks and tool_use blocks from previous message do not match");
        }
      }
    }
    return this.requestStream({
      method: "sampling/createMessage",
      params
    }, CreateMessageResultSchema, options);
  }
  /**
   * Sends an elicitation request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * For task-augmented requests (especially URL-based elicitation), yields 'taskCreated'
   * and 'taskStatus' messages before the final result.
   *
   * @example
   * ```typescript
   * const stream = server.experimental.tasks.elicitInputStream({
   *     mode: 'url',
   *     message: 'Please authenticate',
   *     elicitationId: 'auth-123',
   *     url: 'https://example.com/auth'
   * }, {
   *     task: { ttl: 300000 } // Task-augmented for long-running auth flow
   * });
   *
   * for await (const message of stream) {
   *     switch (message.type) {
   *         case 'taskCreated':
   *             console.log('Task created:', message.task.taskId);
   *             break;
   *         case 'taskStatus':
   *             console.log('Task status:', message.task.status);
   *             break;
   *         case 'result':
   *             console.log('User action:', message.result.action);
   *             break;
   *         case 'error':
   *             console.error('Error:', message.error);
   *             break;
   *     }
   * }
   * ```
   *
   * @param params - The elicitation request parameters
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  elicitInputStream(params, options) {
    const clientCapabilities = this._server.getClientCapabilities();
    const mode = params.mode ?? "form";
    switch (mode) {
      case "url": {
        if (!clientCapabilities?.elicitation?.url) {
          throw new Error("Client does not support url elicitation.");
        }
        break;
      }
      case "form": {
        if (!clientCapabilities?.elicitation?.form) {
          throw new Error("Client does not support form elicitation.");
        }
        break;
      }
    }
    const normalizedParams = mode === "form" && params.mode === void 0 ? { ...params, mode: "form" } : params;
    return this.requestStream({
      method: "elicitation/create",
      params: normalizedParams
    }, ElicitResultSchema, options);
  }
  /**
   * Gets the current status of a task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   * @returns The task status
   *
   * @experimental
   */
  async getTask(taskId, options) {
    return this._server.getTask({ taskId }, options);
  }
  /**
   * Retrieves the result of a completed task.
   *
   * @param taskId - The task identifier
   * @param resultSchema - Zod schema for validating the result
   * @param options - Optional request options
   * @returns The task result
   *
   * @experimental
   */
  async getTaskResult(taskId, resultSchema, options) {
    return this._server.getTaskResult({ taskId }, resultSchema, options);
  }
  /**
   * Lists tasks with optional pagination.
   *
   * @param cursor - Optional pagination cursor
   * @param options - Optional request options
   * @returns List of tasks with optional next cursor
   *
   * @experimental
   */
  async listTasks(cursor, options) {
    return this._server.listTasks(cursor ? { cursor } : void 0, options);
  }
  /**
   * Cancels a running task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   *
   * @experimental
   */
  async cancelTask(taskId, options) {
    return this._server.cancelTask({ taskId }, options);
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/helpers.js
function assertToolsCallTaskCapability(requests, method, entityName) {
  if (!requests) {
    throw new Error(`${entityName} does not support task creation (required for ${method})`);
  }
  switch (method) {
    case "tools/call":
      if (!requests.tools?.call) {
        throw new Error(`${entityName} does not support task creation for tools/call (required for ${method})`);
      }
      break;
    default:
      break;
  }
}
function assertClientRequestTaskCapability(requests, method, entityName) {
  if (!requests) {
    throw new Error(`${entityName} does not support task creation (required for ${method})`);
  }
  switch (method) {
    case "sampling/createMessage":
      if (!requests.sampling?.createMessage) {
        throw new Error(`${entityName} does not support task creation for sampling/createMessage (required for ${method})`);
      }
      break;
    case "elicitation/create":
      if (!requests.elicitation?.create) {
        throw new Error(`${entityName} does not support task creation for elicitation/create (required for ${method})`);
      }
      break;
    default:
      break;
  }
}

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js
var Server = class extends Protocol {
  /**
   * Initializes this server with the given name and version information.
   */
  constructor(_serverInfo, options) {
    super(options);
    this._serverInfo = _serverInfo;
    this._loggingLevels = /* @__PURE__ */ new Map();
    this.LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));
    this.isMessageIgnored = (level, sessionId) => {
      const currentLevel = this._loggingLevels.get(sessionId);
      return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level) < this.LOG_LEVEL_SEVERITY.get(currentLevel) : false;
    };
    this._capabilities = options?.capabilities ?? {};
    this._instructions = options?.instructions;
    this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator();
    this.setRequestHandler(InitializeRequestSchema, (request) => this._oninitialize(request));
    this.setNotificationHandler(InitializedNotificationSchema, () => this.oninitialized?.());
    if (this._capabilities.logging) {
      this.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
        const transportSessionId = extra.sessionId || extra.requestInfo?.headers["mcp-session-id"] || void 0;
        const { level } = request.params;
        const parseResult = LoggingLevelSchema.safeParse(level);
        if (parseResult.success) {
          this._loggingLevels.set(transportSessionId, parseResult.data);
        }
        return {};
      });
    }
  }
  /**
   * Access experimental features.
   *
   * WARNING: These APIs are experimental and may change without notice.
   *
   * @experimental
   */
  get experimental() {
    if (!this._experimental) {
      this._experimental = {
        tasks: new ExperimentalServerTasks(this)
      };
    }
    return this._experimental;
  }
  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  registerCapabilities(capabilities) {
    if (this.transport) {
      throw new Error("Cannot register capabilities after connecting to transport");
    }
    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }
  /**
   * Override request handler registration to enforce server-side validation for tools/call.
   */
  setRequestHandler(requestSchema, handler) {
    const shape = getObjectShape(requestSchema);
    const methodSchema = shape?.method;
    if (!methodSchema) {
      throw new Error("Schema is missing a method literal");
    }
    let methodValue;
    if (isZ4Schema(methodSchema)) {
      const v4Schema = methodSchema;
      const v4Def = v4Schema._zod?.def;
      methodValue = v4Def?.value ?? v4Schema.value;
    } else {
      const v3Schema = methodSchema;
      const legacyDef = v3Schema._def;
      methodValue = legacyDef?.value ?? v3Schema.value;
    }
    if (typeof methodValue !== "string") {
      throw new Error("Schema method literal must be a string");
    }
    const method = methodValue;
    if (method === "tools/call") {
      const wrappedHandler = async (request, extra) => {
        const validatedRequest = safeParse2(CallToolRequestSchema, request);
        if (!validatedRequest.success) {
          const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
        }
        const { params } = validatedRequest.data;
        const result = await Promise.resolve(handler(request, extra));
        if (params.task) {
          const taskValidationResult = safeParse2(CreateTaskResultSchema, result);
          if (!taskValidationResult.success) {
            const errorMessage = taskValidationResult.error instanceof Error ? taskValidationResult.error.message : String(taskValidationResult.error);
            throw new McpError(ErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
          }
          return taskValidationResult.data;
        }
        const validationResult = safeParse2(CallToolResultSchema, result);
        if (!validationResult.success) {
          const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
          throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
        }
        return validationResult.data;
      };
      return super.setRequestHandler(requestSchema, wrappedHandler);
    }
    return super.setRequestHandler(requestSchema, handler);
  }
  assertCapabilityForMethod(method) {
    switch (method) {
      case "sampling/createMessage":
        if (!this._clientCapabilities?.sampling) {
          throw new Error(`Client does not support sampling (required for ${method})`);
        }
        break;
      case "elicitation/create":
        if (!this._clientCapabilities?.elicitation) {
          throw new Error(`Client does not support elicitation (required for ${method})`);
        }
        break;
      case "roots/list":
        if (!this._clientCapabilities?.roots) {
          throw new Error(`Client does not support listing roots (required for ${method})`);
        }
        break;
      case "ping":
        break;
    }
  }
  assertNotificationCapability(method) {
    switch (method) {
      case "notifications/message":
        if (!this._capabilities.logging) {
          throw new Error(`Server does not support logging (required for ${method})`);
        }
        break;
      case "notifications/resources/updated":
      case "notifications/resources/list_changed":
        if (!this._capabilities.resources) {
          throw new Error(`Server does not support notifying about resources (required for ${method})`);
        }
        break;
      case "notifications/tools/list_changed":
        if (!this._capabilities.tools) {
          throw new Error(`Server does not support notifying of tool list changes (required for ${method})`);
        }
        break;
      case "notifications/prompts/list_changed":
        if (!this._capabilities.prompts) {
          throw new Error(`Server does not support notifying of prompt list changes (required for ${method})`);
        }
        break;
      case "notifications/elicitation/complete":
        if (!this._clientCapabilities?.elicitation?.url) {
          throw new Error(`Client does not support URL elicitation (required for ${method})`);
        }
        break;
      case "notifications/cancelled":
        break;
      case "notifications/progress":
        break;
    }
  }
  assertRequestHandlerCapability(method) {
    if (!this._capabilities) {
      return;
    }
    switch (method) {
      case "completion/complete":
        if (!this._capabilities.completions) {
          throw new Error(`Server does not support completions (required for ${method})`);
        }
        break;
      case "logging/setLevel":
        if (!this._capabilities.logging) {
          throw new Error(`Server does not support logging (required for ${method})`);
        }
        break;
      case "prompts/get":
      case "prompts/list":
        if (!this._capabilities.prompts) {
          throw new Error(`Server does not support prompts (required for ${method})`);
        }
        break;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        if (!this._capabilities.resources) {
          throw new Error(`Server does not support resources (required for ${method})`);
        }
        break;
      case "tools/call":
      case "tools/list":
        if (!this._capabilities.tools) {
          throw new Error(`Server does not support tools (required for ${method})`);
        }
        break;
      case "tasks/get":
      case "tasks/list":
      case "tasks/result":
      case "tasks/cancel":
        if (!this._capabilities.tasks) {
          throw new Error(`Server does not support tasks capability (required for ${method})`);
        }
        break;
      case "ping":
      case "initialize":
        break;
    }
  }
  assertTaskCapability(method) {
    assertClientRequestTaskCapability(this._clientCapabilities?.tasks?.requests, method, "Client");
  }
  assertTaskHandlerCapability(method) {
    if (!this._capabilities) {
      return;
    }
    assertToolsCallTaskCapability(this._capabilities.tasks?.requests, method, "Server");
  }
  async _oninitialize(request) {
    const requestedVersion = request.params.protocolVersion;
    this._clientCapabilities = request.params.capabilities;
    this._clientVersion = request.params.clientInfo;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: this.getCapabilities(),
      serverInfo: this._serverInfo,
      ...this._instructions && { instructions: this._instructions }
    };
  }
  /**
   * After initialization has completed, this will be populated with the client's reported capabilities.
   */
  getClientCapabilities() {
    return this._clientCapabilities;
  }
  /**
   * After initialization has completed, this will be populated with information about the client's name and version.
   */
  getClientVersion() {
    return this._clientVersion;
  }
  getCapabilities() {
    return this._capabilities;
  }
  async ping() {
    return this.request({ method: "ping" }, EmptyResultSchema);
  }
  // Implementation
  async createMessage(params, options) {
    if (params.tools || params.toolChoice) {
      if (!this._clientCapabilities?.sampling?.tools) {
        throw new Error("Client does not support sampling tools capability.");
      }
    }
    if (params.messages.length > 0) {
      const lastMessage = params.messages[params.messages.length - 1];
      const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
      const hasToolResults = lastContent.some((c) => c.type === "tool_result");
      const previousMessage = params.messages.length > 1 ? params.messages[params.messages.length - 2] : void 0;
      const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
      const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
      if (hasToolResults) {
        if (lastContent.some((c) => c.type !== "tool_result")) {
          throw new Error("The last message must contain only tool_result content if any is present");
        }
        if (!hasPreviousToolUse) {
          throw new Error("tool_result blocks are not matching any tool_use from the previous message");
        }
      }
      if (hasPreviousToolUse) {
        const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
        const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
        if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) {
          throw new Error("ids of tool_result blocks and tool_use blocks from previous message do not match");
        }
      }
    }
    if (params.tools) {
      return this.request({ method: "sampling/createMessage", params }, CreateMessageResultWithToolsSchema, options);
    }
    return this.request({ method: "sampling/createMessage", params }, CreateMessageResultSchema, options);
  }
  /**
   * Creates an elicitation request for the given parameters.
   * For backwards compatibility, `mode` may be omitted for form requests and will default to `'form'`.
   * @param params The parameters for the elicitation request.
   * @param options Optional request options.
   * @returns The result of the elicitation request.
   */
  async elicitInput(params, options) {
    const mode = params.mode ?? "form";
    switch (mode) {
      case "url": {
        if (!this._clientCapabilities?.elicitation?.url) {
          throw new Error("Client does not support url elicitation.");
        }
        const urlParams = params;
        return this.request({ method: "elicitation/create", params: urlParams }, ElicitResultSchema, options);
      }
      case "form": {
        if (!this._clientCapabilities?.elicitation?.form) {
          throw new Error("Client does not support form elicitation.");
        }
        const formParams = params.mode === "form" ? params : { ...params, mode: "form" };
        const result = await this.request({ method: "elicitation/create", params: formParams }, ElicitResultSchema, options);
        if (result.action === "accept" && result.content && formParams.requestedSchema) {
          try {
            const validator = this._jsonSchemaValidator.getValidator(formParams.requestedSchema);
            const validationResult = validator(result.content);
            if (!validationResult.valid) {
              throw new McpError(ErrorCode.InvalidParams, `Elicitation response content does not match requested schema: ${validationResult.errorMessage}`);
            }
          } catch (error2) {
            if (error2 instanceof McpError) {
              throw error2;
            }
            throw new McpError(ErrorCode.InternalError, `Error validating elicitation response: ${error2 instanceof Error ? error2.message : String(error2)}`);
          }
        }
        return result;
      }
    }
  }
  /**
   * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
   * notification for the specified elicitation ID.
   *
   * @param elicitationId The ID of the elicitation to mark as complete.
   * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
   * @returns A function that emits the completion notification when awaited.
   */
  createElicitationCompletionNotifier(elicitationId, options) {
    if (!this._clientCapabilities?.elicitation?.url) {
      throw new Error("Client does not support URL elicitation (required for notifications/elicitation/complete)");
    }
    return () => this.notification({
      method: "notifications/elicitation/complete",
      params: {
        elicitationId
      }
    }, options);
  }
  async listRoots(params, options) {
    return this.request({ method: "roots/list", params }, ListRootsResultSchema, options);
  }
  /**
   * Sends a logging message to the client, if connected.
   * Note: You only need to send the parameters object, not the entire JSON RPC message
   * @see LoggingMessageNotification
   * @param params
   * @param sessionId optional for stateless and backward compatibility
   */
  async sendLoggingMessage(params, sessionId) {
    if (this._capabilities.logging) {
      if (!this.isMessageIgnored(params.level, sessionId)) {
        return this.notification({ method: "notifications/message", params });
      }
    }
  }
  async sendResourceUpdated(params) {
    return this.notification({
      method: "notifications/resources/updated",
      params
    });
  }
  async sendResourceListChanged() {
    return this.notification({
      method: "notifications/resources/list_changed"
    });
  }
  async sendToolListChanged() {
    return this.notification({ method: "notifications/tools/list_changed" });
  }
  async sendPromptListChanged() {
    return this.notification({ method: "notifications/prompts/list_changed" });
  }
};

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js
import process3 from "node:process";

// node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js
var ReadBuffer = class {
  append(chunk) {
    this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
  }
  readMessage() {
    if (!this._buffer) {
      return null;
    }
    const index = this._buffer.indexOf("\n");
    if (index === -1) {
      return null;
    }
    const line = this._buffer.toString("utf8", 0, index).replace(/\r$/, "");
    this._buffer = this._buffer.subarray(index + 1);
    return deserializeMessage(line);
  }
  clear() {
    this._buffer = void 0;
  }
};
function deserializeMessage(line) {
  return JSONRPCMessageSchema.parse(JSON.parse(line));
}
function serializeMessage(message) {
  return JSON.stringify(message) + "\n";
}

// node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js
var StdioServerTransport = class {
  constructor(_stdin = process3.stdin, _stdout = process3.stdout) {
    this._stdin = _stdin;
    this._stdout = _stdout;
    this._readBuffer = new ReadBuffer();
    this._started = false;
    this._ondata = (chunk) => {
      this._readBuffer.append(chunk);
      this.processReadBuffer();
    };
    this._onerror = (error2) => {
      this.onerror?.(error2);
    };
  }
  /**
   * Starts listening for messages on stdin.
   */
  async start() {
    if (this._started) {
      throw new Error("StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.");
    }
    this._started = true;
    this._stdin.on("data", this._ondata);
    this._stdin.on("error", this._onerror);
  }
  processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error2) {
        this.onerror?.(error2);
      }
    }
  }
  async close() {
    this._stdin.off("data", this._ondata);
    this._stdin.off("error", this._onerror);
    const remainingDataListeners = this._stdin.listenerCount("data");
    if (remainingDataListeners === 0) {
      this._stdin.pause();
    }
    this._readBuffer.clear();
    this.onclose?.();
  }
  send(message) {
    return new Promise((resolve6) => {
      const json = serializeMessage(message);
      if (this._stdout.write(json)) {
        resolve6();
      } else {
        this._stdout.once("drain", resolve6);
      }
    });
  }
};

// src/providers/contract.mjs
var CONTRACT_METHODS = Object.freeze(["discover", "run", "describeError"]);
function assertProviderShape(provider) {
  if (!provider || typeof provider !== "object" || typeof provider.id !== "string" || provider.id === "") {
    throw new Error("provider must expose a non-empty string id");
  }
  for (const method of CONTRACT_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(`provider '${provider.id}' is missing ${method}()`);
    }
  }
  return provider;
}

// src/providers/resolve-binary.mjs
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
var WINDOWS_EXECUTABLE_EXTS = Object.freeze([".EXE", ".COM"]);
var WINDOWS_SHIM_EXTS = Object.freeze([".CMD", ".BAT"]);
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function readEnvValue(env, name) {
  const direct = env?.[name];
  if (typeof direct === "string" && direct !== "") return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env ?? {})) {
    const value = env[key];
    if (key.toLowerCase() === wanted && typeof value === "string" && value !== "") return value;
  }
  return void 0;
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function pathDirs(value) {
  const out = [];
  for (const raw of (value ?? "").split(delimiter)) {
    const dir = normalizePathEntry(raw);
    if (dir !== "" && isAbsolute(dir)) out.push(dir);
  }
  return out;
}
function normalizePathEntry(raw) {
  let dir = String(raw ?? "").trim();
  if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim();
  return dir;
}
function notFoundError(basename3) {
  const error2 = new Error(`the ${basename3} CLI was not found on PATH`);
  error2.code = "cli_not_found";
  error2.binaryName = basename3;
  return error2;
}
function shimOnlyError(basename3, shimPath) {
  const error2 = new Error(`only a shell shim for the ${basename3} CLI was found: ${shimPath}`);
  error2.code = "cli_shim_only";
  error2.binaryName = basename3;
  error2.shimPath = shimPath;
  return error2;
}
function resolveBinary({
  basename: basename3,
  execPathVar = null,
  env = process.env,
  platform = process.platform
} = {}) {
  const windows = platform === "win32";
  if (typeof execPathVar === "string" && execPathVar !== "") {
    const pinned = readEnvValue(env, execPathVar);
    if (typeof pinned === "string" && isAbsolute(pinned) && isFile(pinned)) {
      const upper = pinned.toUpperCase();
      if (windows && WINDOWS_SHIM_EXTS.some((ext) => upper.endsWith(ext))) throw shimOnlyError(basename3, pinned);
      return pinned;
    }
  }
  const dirs = pathDirs(readEnvValue(env, "PATH"));
  if (!windows) {
    for (const dir of dirs) {
      const candidate = join(dir, basename3);
      if (isFile(candidate)) return candidate;
    }
    throw notFoundError(basename3);
  }
  const declared = new Set(
    (readEnvValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").map((e) => e.trim().toUpperCase()).filter((e) => e !== "")
  );
  const executableExts = WINDOWS_EXECUTABLE_EXTS.filter((e) => declared.has(e));
  const shimExts = WINDOWS_SHIM_EXTS.filter((e) => declared.has(e));
  let firstShim = null;
  for (const dir of dirs) {
    for (const ext of executableExts) {
      const candidate = join(dir, basename3 + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
    if (firstShim === null) {
      for (const ext of shimExts) {
        const candidate = join(dir, basename3 + ext.toLowerCase());
        if (isFile(candidate)) {
          firstShim = candidate;
          break;
        }
      }
    }
  }
  if (firstShim !== null) throw shimOnlyError(basename3, firstShim);
  throw notFoundError(basename3);
}
function resolveThroughShim(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shimPath);
  const PLACEHOLDERS = /^(?:%~?dp0%|\$basedir|\$\{basedir\}|\.)[\\/]?/;
  for (const match of text.matchAll(/[^\s"'()]+\.(?:js|mjs|cjs)\b/g)) {
    const raw = match[0].replace(PLACEHOLDERS, "");
    if (raw === "") continue;
    const candidate = isAbsolute(raw) ? raw : resolve(dir, raw);
    if (isFile(candidate)) {
      return { command: process.execPath, prefixArgs: [candidate] };
    }
  }
  return null;
}
function resolveLaunch(options = {}) {
  try {
    return { command: resolveBinary(options), prefixArgs: [] };
  } catch (error2) {
    if (error2?.code !== "cli_shim_only" || typeof error2.shimPath !== "string") throw error2;
    const throughShim = resolveThroughShim(error2.shimPath);
    if (throughShim) return throughShim;
    throw error2;
  }
}

// src/providers/claude-args.mjs
var READ_ONLY_ROLES = Object.freeze(["planner", "thinker"]);
var WRITE_ROLES = Object.freeze(["worker", "verifier"]);
var BASE_ARGS = Object.freeze(["-p", "--output-format", "stream-json", "--verbose"]);
var SETTING_SOURCES = "user";
function unknownRoleError(role) {
  const error2 = new Error(`unknown delegate role: ${JSON.stringify(role)}`);
  error2.code = "unknown_role";
  error2.role = role;
  return error2;
}
function allowedToolsRequiredError(role) {
  const error2 = new Error(`role '${role}' needs a non-empty allowedTools list`);
  error2.code = "allowed_tools_required";
  error2.role = role;
  return error2;
}
function unsafeToolPatternError(role, pattern) {
  const error2 = new Error(`allowedTools entry looks like a flag: ${JSON.stringify(pattern)}`);
  error2.code = "unsafe_tool_pattern";
  error2.role = role;
  error2.pattern = pattern;
  return error2;
}
function toolSetRequiredError(role, value) {
  const error2 = new Error(
    `role '${role}' needs a non-empty toolSet \u2014 the tool set is the only flag that is actually enforced (got ${JSON.stringify(value) ?? String(value)})`
  );
  error2.code = "tool_set_required";
  error2.role = role;
  error2.toolSet = value;
  return error2;
}
function invalidPermissionModeError(mode) {
  const error2 = new Error(`permissionMode must be a non-empty string, got ${typeof mode}`);
  error2.code = "invalid_permission_mode";
  error2.permissionMode = mode;
  return error2;
}
function buildClaudeArgs({
  role,
  model = null,
  effort = null,
  allowedTools = [],
  toolSet = null,
  permissionMode = "bypassPermissions"
} = {}) {
  const readOnly = READ_ONLY_ROLES.includes(role);
  const write = WRITE_ROLES.includes(role);
  if (!readOnly && !write) throw unknownRoleError(role);
  const args = [...BASE_ARGS];
  if (typeof model === "string" && model !== "") args.push("--model", model);
  if (typeof effort === "string" && effort !== "") args.push("--effort", effort);
  if (readOnly) {
    args.push("--tools", "");
    return args;
  }
  const tools = Array.isArray(allowedTools) ? allowedTools.filter((t) => typeof t === "string" && t !== "") : [];
  if (tools.length === 0) throw allowedToolsRequiredError(role);
  for (const tool of tools) {
    if (tool.startsWith("-")) throw unsafeToolPatternError(role, tool);
  }
  if (typeof permissionMode !== "string" || permissionMode === "") {
    throw invalidPermissionModeError(permissionMode);
  }
  const set = (Array.isArray(toolSet) ? toolSet : []).filter((tool) => typeof tool === "string").map((tool) => tool.trim()).filter((tool) => tool !== "");
  if (set.length === 0) throw toolSetRequiredError(role, toolSet);
  for (const tool of set) {
    if (tool.startsWith("-")) throw unsafeToolPatternError(role, tool);
  }
  args.push("--tools", set.join(","));
  args.push("--setting-sources", SETTING_SOURCES, "--strict-mcp-config");
  args.push("--permission-mode", permissionMode);
  args.push("--allowedTools", ...tools);
  return args;
}

// src/providers/child-env.mjs
import { statSync as statSync2 } from "node:fs";
import { delimiter as delimiter2, isAbsolute as isAbsolute2 } from "node:path";
var CMD_ENV_VALUE_LIMIT = 8191;
function compactPath(rawPath, options = {}) {
  const raw = typeof rawPath === "string" ? rawPath : "";
  const windows = (options.platform ?? process.platform) === "win32";
  const limit = options.limit ?? CMD_ENV_VALUE_LIMIT;
  const prepend = Array.isArray(options.prepend) ? options.prepend.filter((d) => typeof d === "string" && d !== "") : [];
  const rawEntries = raw === "" ? [] : raw.split(delimiter2);
  let entries = rawEntries;
  if (prepend.length > 0) {
    const front = new Set(prepend.map((d) => foldPathKey(d, windows)));
    entries = [...prepend, ...rawEntries.filter((d) => !front.has(foldPathKey(d, windows)))];
  }
  const base = {
    originalChars: raw.length,
    originalEntries: rawEntries.length,
    duplicatesDropped: 0,
    missingDropped: 0,
    stillOverLimit: false,
    allDropped: false
  };
  const joined = entries.join(delimiter2);
  if (!windows || joined.length <= limit) {
    return { ...base, value: joined, chars: joined.length, entries: entries.length, cleaned: false };
  }
  const seen = /* @__PURE__ */ new Set();
  const kept = [];
  let duplicatesDropped = 0;
  let missingDropped = 0;
  for (const entry of entries) {
    const dir = normalizePathEntry(entry);
    if (dir === "" || !isAbsolute2(dir)) {
      missingDropped += 1;
      continue;
    }
    const key = foldPathKey(dir, windows);
    if (seen.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(key);
    if (!isDirectorySync(dir)) {
      missingDropped += 1;
      continue;
    }
    kept.push(dir);
  }
  const allDropped = kept.length === 0 && entries.length > 0;
  const value = allDropped ? joined : kept.join(delimiter2);
  return {
    ...base,
    value,
    chars: value.length,
    entries: allDropped ? entries.length : kept.length,
    duplicatesDropped,
    missingDropped,
    cleaned: !allDropped,
    allDropped,
    stillOverLimit: value.length > limit
  };
}
function foldPathKey(dir, windows) {
  const trimmed = String(dir).trim().replace(/[\\/]+$/, "");
  return windows ? trimmed.toLowerCase() : trimmed;
}
function isDirectorySync(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function pathNotes(result, limit) {
  const notes = [];
  if (result.allDropped) {
    notes.push(
      `PATH \uAC00 ${result.originalChars}\uC790\uC5EC\uC11C \uC904\uC774\uB824 \uD588\uC9C0\uB9CC \uBAA8\uB4E0 \uD56D\uBAA9(${result.originalEntries}\uAC1C)\uC774 \uAC78\uB7EC\uC838 \uB0A8\uB294 \uAC83\uC774 \uC5C6\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uBE48 PATH \uB97C \uBB3C\uB824\uC8FC\uC9C0 \uC54A\uC73C\uB824\uACE0 \uC6D0\uBCF8\uC744 \uADF8\uB300\uB85C \uB118\uACBC\uC2B5\uB2C8\uB2E4.`
    );
  }
  if (result.cleaned) {
    notes.push(
      `PATH \uAC00 ${result.originalChars}\uC790\uC5EC\uC11C ${result.chars}\uC790\uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4 (\uC911\uBCF5 ${result.duplicatesDropped}\uAC1C, \uC874\uC7AC\uD558\uC9C0 \uC54A\uAC70\uB098 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2CC \uD56D\uBAA9 ${result.missingDropped}\uAC1C \uC81C\uAC70) \u2014 cmd.exe \uB294 ${limit}\uC790\uB97C \uB118\uB294 \uD658\uACBD \uBCC0\uC218\uB97C \uBE48 \uAC12\uC73C\uB85C \uBD05\uB2C8\uB2E4.`
    );
  }
  if (result.stillOverLimit) {
    notes.push(
      `\uC815\uB9AC\uD55C \uB4A4\uC5D0\uB3C4 PATH \uAC00 ${result.chars}\uC790\uB85C \uC0C1\uD55C\uC744 \uB118\uC2B5\uB2C8\uB2E4 \u2014 \uC798\uB77C\uB0B4\uBA74 \uB4A4\uCABD \uB514\uB809\uD130\uB9AC\uC758 \uB3C4\uAD6C\uB97C \uC870\uC6A9\uD788 \uC783\uC73C\uBBC0\uB85C \uADF8\uB300\uB85C \uB480\uC2B5\uB2C8\uB2E4. \uC790\uC2DD\uC774 \uC178\uC744 \uB744\uC6B0\uBA74 \uADF8 \uC178\uC5D0\uC11C PATH \uAC00 \uBE44\uC5B4 \uBCF4\uC785\uB2C8\uB2E4.`
    );
  }
  return notes;
}
var BASE_ALLOWLIST = Object.freeze([
  // 프로세스가 시작하려면 필요한 것
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "ComSpec",
  "PATHEXT",
  // Windows 의 기본 설치 위치. MSBuild/NuGet 이 머신 와이드 설정 경로를 이것으로 만든다.
  // 실측: 이 중 ProgramFiles 하나만 빠져도 `dotnet restore` 가
  // `NuGet.targets(782,5): error : Value cannot be null. (Parameter 'path1')` 로 죽는다
  // (env 만 이분해 확인). 32/64비트 두 갈래와 SDK 가 읽는 머신 와이드 경로가 각각
  // 다른 변수를 쓰므로 같은 부류를 함께 넣는다. 인증 변수가 아니라 S1 표면과 무관하다.
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "SystemDrive",
  // 네트워크에 닿을 수 있는지를 결정하는 것. 이게 빠지면 회사 프록시 뒤의 사용자는
  // 자기 CLI 는 잘 되는데 델리게이트만 설명 없이 연결 실패한다. 사내 TLS 가로채기
  // 인증서도 같은 증상·같은 원인이라 같이 통과시킨다.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // 사용자가 고른 언어
  "LANG",
  "LC_ALL"
]);
var DUAL_CASE = Object.freeze(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY"]);
var CLAUDE_AUTH_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR"
]);
var CODEX_AUTH_NAMES = Object.freeze([
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_BASE_URL"
]);
function readEnvValue2(env, name) {
  const direct = env[name];
  if (typeof direct === "string" && direct !== "") return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (key.toLowerCase() === wanted && typeof value === "string" && value !== "") return value;
  }
  return void 0;
}
function buildChildEnv(env = process.env, { authNames = [], runId, extra, pathPrepend, notes, platform } = {}) {
  const childEnv = {};
  for (const name of [...BASE_ALLOWLIST, ...authNames]) {
    const value = readEnvValue2(env, name);
    if (value !== void 0) childEnv[name] = value;
  }
  for (const name of DUAL_CASE) {
    if (childEnv[name] !== void 0) childEnv[name.toLowerCase()] = childEnv[name];
  }
  if (childEnv.PATH !== void 0 || Array.isArray(pathPrepend) && pathPrepend.length > 0) {
    const compacted = compactPath(childEnv.PATH ?? "", { platform, prepend: pathPrepend });
    if (compacted.value !== "") childEnv.PATH = compacted.value;
    if (Array.isArray(notes)) notes.push(...pathNotes(compacted, CMD_ENV_VALUE_LIMIT));
  }
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") childEnv[key] = value;
    }
  }
  if (typeof runId === "string" && runId !== "") childEnv.BOM_ORCH_RUN_ID = runId;
  childEnv.NoDefaultCurrentDirectoryInExePath = "1";
  return childEnv;
}

// src/providers/claude-stream.mjs
var KNOWN_TYPES = /* @__PURE__ */ new Set(["system", "assistant", "user", "result", "rate_limit_event"]);
var KNOWN_SYSTEM_SUBTYPES = /* @__PURE__ */ new Set(["init", "hook_started", "hook_response", "thinking_tokens"]);
var KNOWN_BLOCK_TYPES = /* @__PURE__ */ new Set(["text", "tool_use", "tool_result", "thinking"]);
function parseStreamLine(line) {
  const raw = typeof line === "string" ? line : String(line ?? "");
  try {
    const record2 = JSON.parse(raw);
    if (record2 === null || typeof record2 !== "object" || Array.isArray(record2)) return { ok: false, raw };
    return { ok: true, record: record2 };
  } catch {
    return { ok: false, raw };
  }
}
function positiveOrNull(value) {
  return Number.isInteger(value) ? value : null;
}
function extractUsage(record2) {
  const usage = record2?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: positiveOrNull(usage.input_tokens),
    outputTokens: positiveOrNull(usage.output_tokens),
    cacheCreationInputTokens: positiveOrNull(usage.cache_creation_input_tokens),
    cacheReadInputTokens: positiveOrNull(usage.cache_read_input_tokens)
  };
}
function isTruncated(collected) {
  return collected?.stopReason === "max_tokens" || collected?.subtype === "error_max_turns";
}
function collectStream(text) {
  const assistantText = [];
  const toolOrder = [];
  const toolById = /* @__PURE__ */ new Map();
  const unknownTypes = /* @__PURE__ */ new Set();
  const unparsableLines = [];
  let lastResult = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = parseStreamLine(line);
    if (!parsed.ok) {
      unparsableLines.push(parsed.raw);
      continue;
    }
    const record2 = parsed.record;
    if (!KNOWN_TYPES.has(record2.type)) {
      unknownTypes.add(String(record2.type));
      continue;
    }
    if (record2.type === "result") {
      lastResult = record2;
      continue;
    }
    if (record2.type === "system" && !KNOWN_SYSTEM_SUBTYPES.has(String(record2.subtype))) {
      unknownTypes.add(`system/${record2.subtype}`);
      continue;
    }
    const content = Array.isArray(record2.message?.content) ? record2.message.content : [];
    for (const block of content) {
      if (typeof block?.type === "string" && !KNOWN_BLOCK_TYPES.has(block.type)) {
        unknownTypes.add(`content:${block.type}`);
        continue;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        assistantText.push(block.text);
      } else if (block?.type === "tool_use" && typeof block.id === "string") {
        if (!toolById.has(block.id)) {
          const entry = { id: block.id, name: block.name ?? null, input: block.input ?? null, result: null };
          toolById.set(block.id, entry);
          toolOrder.push(entry);
        }
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const entry = toolById.get(block.tool_use_id);
        if (entry) entry.result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      }
    }
  }
  const resultText = typeof lastResult?.result === "string" ? lastResult.result : null;
  return {
    text: resultText ?? assistantText.join(""),
    toolUses: toolOrder,
    usage: lastResult ? extractUsage(lastResult) : null,
    // ★ 계획 2 시점의 사실: 파싱만 하고 **아무도 안 읽는다.** 설계 §5.4 는 "비어 있지
    //   않으면 그 스텝은 실패" 라는 규칙을 세웠는데 §12.0 이 그 전제를 뒤집었다 — 목록 밖
    //   명령이 실행되는데도 `permission_denials: []` 인 경우가 실측됐다. 그래서 이 값으로
    //   스텝을 실패시키지 않는다. 다만 이 필드가 무엇을 말하는지는 아직 쓸모가 있어
    //   (라이브 스위트가 진단으로 찍는다) 남긴다. 소비할지 말지는 계획 3 이 정한다.
    permissionDenials: Array.isArray(lastResult?.permission_denials) ? lastResult.permission_denials : [],
    stopReason: lastResult?.stop_reason ?? null,
    subtype: lastResult?.subtype ?? null,
    isError: lastResult?.is_error === true,
    numTurns: Number.isInteger(lastResult?.num_turns) ? lastResult.num_turns : null,
    unknownTypes: [...unknownTypes].sort(),
    unparsableLines
  };
}

// src/providers/run-cli.mjs
import { spawn } from "node:child_process";
var WINDOWS = process.platform === "win32";
var KILL_GRACE_MS = 3e3;
var DEFAULT_TIMEOUT_MS = 6e5;
function parseProgressLine(line) {
  const raw = typeof line === "string" ? line : String(line ?? "");
  try {
    const record2 = JSON.parse(raw);
    if (record2 === null || typeof record2 !== "object" || Array.isArray(record2)) return { ok: false };
    return { ok: true, record: record2 };
  } catch {
    return { ok: false };
  }
}
function createLineSplitter() {
  let remainder = "";
  return {
    push(chunk) {
      const text = remainder + String(chunk);
      const parts = text.split(/\r?\n/);
      remainder = parts.pop() ?? "";
      return parts.filter((line) => line !== "");
    },
    flush() {
      const last = remainder;
      remainder = "";
      return last === "" ? [] : [last];
    }
  };
}
async function runCli({
  binary,
  prefixArgs = [],
  args = [],
  instruction = "",
  cwd,
  env = process.env,
  signal,
  timeoutMs,
  onProgress,
  onSpawn,
  runId,
  authNames = [],
  collect: collect2,
  sendStdin = true
} = {}) {
  const fail = (extra) => ({
    ...collect2(""),
    exitCode: null,
    signalName: null,
    stderr: "",
    timedOut: false,
    aborted: false,
    hung: false,
    spawnError: null,
    ...extra
  });
  if (signal?.aborted) return fail({ aborted: true });
  const childEnv = buildChildEnv(env, { authNames, runId });
  let child;
  try {
    child = spawn(binary, [...prefixArgs, ...args], {
      env: childEnv,
      // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      cwd,
      shell: false,
      // 프롬프트 텍스트가 명령줄 인용 규칙을 만나지 않게 한다
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 나중에 손자까지 끊을 수 있다.
      // Windows 에서 detached 는 "콘솔 없음"일 뿐이고 트리 종료는 taskkill /T 가 한다.
      ...WINDOWS ? {} : { detached: true }
    });
  } catch (error2) {
    return fail({ spawnError: error2 });
  }
  const splitter = createLineSplitter();
  const lines = [];
  const stderrChunks = [];
  let stopReason = null;
  let finished = false;
  const handleLine = (line) => {
    lines.push(line);
    if (typeof onProgress !== "function") return;
    const parsed = parseProgressLine(line);
    if (!parsed.ok) return;
    try {
      onProgress(parsed.record);
    } catch {
    }
  };
  let hardTimer = null;
  let hardSettle = null;
  const stop = (reason) => {
    if (finished) return;
    if (stopReason === null) stopReason = reason;
    try {
      child.kill();
    } catch {
    }
    if (hardTimer === null) hardTimer = setTimeout(() => hardSettle?.(), KILL_GRACE_MS);
  };
  const onAbort = () => stop("aborted");
  let timer = null;
  try {
    if (typeof onSpawn === "function") {
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === "function") tracked.catch(() => {
      });
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    signal?.addEventListener("abort", onAbort, { once: true });
    const cap = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    timer = setTimeout(() => stop("timedOut"), cap);
    child.stdin.on("error", () => {
    });
    if (sendStdin) {
      child.stdin.end(typeof instruction === "string" ? instruction : String(instruction ?? ""));
    } else {
      child.stdin.end();
    }
  } catch (error2) {
    if (timer) clearTimeout(timer);
    try {
      signal?.removeEventListener?.("abort", onAbort);
    } catch {
    }
    stop("setupFailed");
    return fail({ spawnError: error2 });
  }
  const outcome = await new Promise((resolve6) => {
    let settled = false;
    const settle2 = (value) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(hardTimer);
      resolve6(value);
    };
    hardSettle = () => settle2({ spawnError: null, hung: true });
    child.on("error", (error2) => settle2({ spawnError: error2, hung: false }));
    child.on("close", () => settle2({ spawnError: null, hung: false }));
  });
  const spawnError = outcome.spawnError;
  const hung = outcome.hung === true;
  if (timer) clearTimeout(timer);
  clearTimeout(hardTimer);
  if (hung) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  try {
    signal?.removeEventListener("abort", onAbort);
  } catch {
  }
  for (const line of splitter.flush()) handleLine(line);
  const collected = collect2(lines.join("\n"));
  const exitCode = spawnError ? null : child.exitCode;
  const cutShort = spawnError === null && exitCode !== 0;
  return {
    ...collected,
    exitCode,
    signalName: child.signalCode ?? null,
    stderr: stderrChunks.join(""),
    // `hung` 을 여기 섞지 않는다. 자식이 스스로 exit 0 으로 끝났는데 손자가 파이프를 쥔
    // 경우가 실제로 있고(그때 결과는 완전하다), 섞으면 위 주석의 오탐이 되살아난다.
    timedOut: stopReason === "timedOut" && cutShort,
    aborted: stopReason === "aborted" && cutShort,
    // 끊은 뒤에도 파이프가 닫히지 않아 결과를 기다리지 않고 나왔다. 자식(또는 그 손자)이
    // 아직 살아 있을 수 있고, reparent 된 손자는 트리 킬로도 안 잡힌다(reaper.mjs).
    hung,
    spawnError
  };
}

// src/providers/claude-run.mjs
function runClaude(options = {}) {
  return runCli({ ...options, authNames: CLAUDE_AUTH_NAMES, collect: collectStream, sendStdin: true });
}

// src/providers/discover-parse.mjs
function parseClaudeHelp(helpText) {
  if (typeof helpText !== "string" || helpText.trim() === "") return { aliases: [], efforts: [] };
  const modelBlock = extractOptionBlock(helpText, "--model <model>");
  const aliases = [...modelBlock.matchAll(/'([a-z][a-z0-9.\-]*)'/g)].map((m) => m[1]).filter((alias) => !alias.startsWith("claude-")).filter((alias, i, all) => all.indexOf(alias) === i);
  const effortBlock = extractOptionBlock(helpText, "--effort <level>");
  const effortMatch = effortBlock.match(/\(([a-z]+(?:\s*,\s*[a-z]+)+)\)/);
  const efforts = effortMatch ? effortMatch[1].split(",").map((e) => e.trim()).filter((e) => e !== "") : [];
  return { aliases, efforts };
}
function extractOptionBlock(helpText, optionStart) {
  const lines = helpText.split("\n");
  const block = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!inBlock) {
      if (line.trimStart().startsWith(optionStart)) {
        inBlock = true;
        block.push(line);
      }
      continue;
    }
    if (/^\s{0,10}-{1,2}[A-Za-z]/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}
function parseCodexModels(jsonText) {
  if (typeof jsonText !== "string" || jsonText.trim() === "") return { ok: false, models: [] };
  let root;
  try {
    root = JSON.parse(jsonText);
  } catch {
    return { ok: false, models: [] };
  }
  if (root === null || typeof root !== "object" || !Array.isArray(root.models)) {
    return { ok: false, models: [] };
  }
  const listed = [];
  for (const model of root.models) {
    if (model === null || typeof model !== "object") continue;
    if (typeof model.visibility !== "string" || model.visibility.toLowerCase() !== "list") continue;
    if (typeof model.slug !== "string" || model.slug.trim() === "") continue;
    const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter((l) => l !== null && typeof l === "object" && typeof l.effort === "string" && l.effort !== "").map((l) => l.effort).filter((e, i, all) => all.indexOf(e) === i) : [];
    const defaultEffort = typeof model.default_reasoning_level === "string" && model.default_reasoning_level !== "" ? model.default_reasoning_level : null;
    const contextWindow = Number.isInteger(model.context_window) && model.context_window > 0 ? model.context_window : null;
    const priority = Number.isInteger(model.priority) ? model.priority : Number.MAX_SAFE_INTEGER;
    listed.push({ entry: { name: model.slug, efforts, defaultEffort, contextWindow }, priority });
  }
  if (listed.length === 0) return { ok: false, models: [] };
  const models = listed.sort((a, b) => a.priority - b.priority).map((item) => item.entry);
  return { ok: true, models };
}

// src/providers/claude.mjs
function extractMessage(error2) {
  if (typeof error2 === "string") return error2 !== "" ? error2 : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  if (error2 instanceof Error && typeof error2.message === "string" && error2.message !== "") return error2.message;
  if (error2 && typeof error2 === "object" && typeof error2.message === "string" && error2.message !== "") {
    return error2.message;
  }
  if (error2 && typeof error2 === "object") {
    if (Number.isInteger(error2.exitCode)) return `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uC885\uB8CC \uCF54\uB4DC ${error2.exitCode} \uB85C \uB05D\uB0AC\uB2E4`;
    if (typeof error2.code === "string" && error2.code !== "") return error2.code;
  }
  return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
}
function buildFailureError(runResult) {
  if (runResult.spawnError) return runResult.spawnError;
  const stderr = typeof runResult.stderr === "string" ? runResult.stderr.trim() : "";
  return {
    code: "cli_exit_nonzero",
    exitCode: runResult.exitCode,
    stderr: runResult.stderr,
    message: stderr !== "" ? stderr : void 0
  };
}
function sandboxNotice(role, platform) {
  if (!WRITE_ROLES.includes(role) || platform !== "win32") return null;
  return "claude \uB294 native Windows \uC5D0\uC11C OS \uC0CC\uB4DC\uBC15\uC2A4 \uC5C6\uC774 \uB3D5\uB2C8\uB2E4. \uC2E4\uCE21 \uACB0\uACFC --allowedTools \uB294 \uBA85\uB839 \uC2E4\uD589\uC744 \uC81C\uD55C\uD558\uC9C0 \uBABB\uD558\uBBC0\uB85C(\uC124\uACC4 \xA712.0), \uC774 \uC2E4\uD589\uC758 \uC178\xB7\uB124\uD2B8\uC6CC\uD06C \uC811\uADFC\uC740 \uC0AC\uC2E4\uC0C1 \uBB34\uC81C\uD55C\uC785\uB2C8\uB2E4 \u2014 \uC2E4\uC81C \uACA9\uB9AC\uB294 \uC77C\uD68C\uC6A9 \uC6CC\uD06C\uD2B8\uB9AC\uC758 \uD30C\uC77C\uC2DC\uC2A4\uD15C \uBC94\uC704\uBFD0\uC785\uB2C8\uB2E4. WSL2/Linux \uC5D0\uC11C\uB294 OS \uC0CC\uB4DC\uBC15\uC2A4\uAC00 \uB3D9\uC791\uD569\uB2C8\uB2E4.";
}
function describeError(error2) {
  try {
    const code = error2 && typeof error2 === "object" ? error2.code : void 0;
    if (code === "cli_not_found") {
      const name = typeof error2.binaryName === "string" && error2.binaryName !== "" ? error2.binaryName : "claude";
      return {
        error: `${name} CLI \uB97C PATH \uC5D0\uC11C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
        recovery: "Claude Code \uB97C \uC124\uCE58\uD558\uACE0 `claude --version` \uC774 \uB3D9\uC791\uD558\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      };
    }
    if (code === "cli_shim_only") {
      const shimPath = typeof error2.shimPath === "string" ? error2.shimPath : "\uACBD\uB85C \uBD88\uBA85";
      return {
        error: `claude CLI \uB294 \uC178 \uC148\uB9CC \uBC1C\uACAC\uB410\uC2B5\uB2C8\uB2E4: ${shimPath}`,
        recovery: `\uB124\uC774\uD2F0\uBE0C claude \uC2E4\uD589 \uD30C\uC77C\uC744 \uC124\uCE58\uD558\uC138\uC694(\uBC1C\uACAC\uB41C \uC148: ${shimPath}). \uC774 \uC800\uC7A5\uC18C\uB294 shell:false \uB85C\uB9CC \uC2A4\uD3F0\uD558\uBBC0\uB85C \uC148\uC744 \uC9C1\uC811 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`
      };
    }
    if (code === "unknown_role" || code === "allowed_tools_required" || code === "tool_set_required" || code === "unsafe_tool_pattern" || code === "invalid_permission_mode") {
      return {
        error: `\uD638\uCD9C\uBD80 \uBC84\uADF8: ${extractMessage(error2)}`,
        recovery: "\uB378\uB9AC\uAC8C\uC774\uD2B8 \uD638\uCD9C \uCF54\uB4DC\uC758 role/allowedTools/permissionMode \uC124\uC815\uC744 \uC810\uAC80\uD558\uC138\uC694."
      };
    }
    return {
      error: extractMessage(error2),
      recovery: "claude \uC2E4\uD589 \uB85C\uADF8(stderr)\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    };
  } catch {
    return { error: "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958", recovery: "claude \uC2E4\uD589 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uC138\uC694." };
  }
}
async function discover(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? resolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: "claude", execPathVar: "CLAUDE_CODE_EXECPATH" });
  } catch (error2) {
    return { reachable: false, ...describeError(error2) };
  }
  const versionResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ["--version"],
    instruction: "",
    signal,
    authNames: CLAUDE_AUTH_NAMES
  });
  if (versionResult.spawnError || versionResult.exitCode !== 0 && versionResult.exitCode !== null) {
    return {
      reachable: false,
      ...describeError(versionResult.spawnError ?? { code: "cli_exit_nonzero", stderr: versionResult.stderr })
    };
  }
  const version2 = typeof versionResult.text === "string" ? versionResult.text.trim() : void 0;
  const helpResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ["--help"],
    instruction: "",
    signal,
    authNames: CLAUDE_AUTH_NAMES
  });
  const { aliases, efforts } = parseClaudeHelp(helpResult.text ?? "");
  const models = aliases.map((name) => ({
    name,
    efforts,
    defaultEffort: efforts[0] ?? null,
    contextWindow: null
  }));
  return { reachable: true, version: version2, models };
}
async function run({
  role,
  model = null,
  effort = null,
  instruction = "",
  workspace,
  allowedTools = [],
  // contract.mjs 의 범용 이름. claude 에서는 **강제되는 도구 집합**(`--tools`)이다 —
  // `--allowedTools` 는 실행을 제한하지 못한다(설계 §12.0 실측).
  tools,
  signal,
  onProgress,
  onSpawn,
  runId,
  platform = process.platform,
  deps = {}
} = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? resolveLaunch;
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: "claude", execPathVar: "CLAUDE_CODE_EXECPATH" });
  } catch (error2) {
    return {
      content: "",
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError(error2)
    };
  }
  let args;
  try {
    args = deps.args ?? buildClaudeArgs({ role, model, effort, allowedTools, toolSet: tools });
  } catch (error2) {
    return {
      content: "",
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError(error2)
    };
  }
  const runResult = await runClaude({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args,
    instruction,
    cwd: workspace,
    signal,
    onProgress,
    onSpawn,
    runId
  });
  const noTerminalRecord = runResult.subtype === null || runResult.subtype === void 0;
  const cleanExit = runResult.spawnError === null && runResult.exitCode === 0;
  const truncated = isTruncated(runResult) || runResult.timedOut === true || runResult.aborted === true || noTerminalRecord && !cleanExit;
  const doneReason = runResult.stopReason ?? runResult.subtype ?? (runResult.timedOut ? "timeout" : runResult.aborted ? "aborted" : null);
  const envelope = {
    content: typeof runResult.text === "string" ? runResult.text : "",
    model: model ?? null,
    promptTokens: runResult.usage?.inputTokens ?? null,
    evalTokens: runResult.usage?.outputTokens ?? null,
    truncated,
    doneReason,
    // notice 는 답변이 아니라 실행에 대한 진술이다 — content 에 이어붙이지 않는다.
    notice: sandboxNotice(role, platform)
  };
  const failed = runResult.spawnError || runResult.exitCode !== 0 && runResult.exitCode !== null;
  if (failed) {
    Object.assign(envelope, describeError(buildFailureError(runResult)));
  }
  return envelope;
}
var claudeProvider = {
  id: "claude",
  discover,
  run,
  describeError
};

// src/providers/codex-args.mjs
var READ_ONLY_ROLES2 = Object.freeze(["planner", "thinker"]);
var WRITE_ROLES2 = Object.freeze(["worker", "verifier"]);
var WORKSPACE_WRITE_ROLES = Object.freeze(["worker"]);
var BASE_ARGS2 = Object.freeze(["exec", "--json", "--ephemeral"]);
var BANNED_EXACT = Object.freeze([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "danger-full-access"
]);
var BANNED_CONFIG_KEYS = Object.freeze(["sandbox_workspace_write.network_access"]);
function unknownRoleError2(role) {
  const error2 = new Error(`unknown delegate role: ${JSON.stringify(role)}`);
  error2.code = "unknown_role";
  error2.role = role;
  return error2;
}
function unsafeArgumentError(name, value) {
  const error2 = new Error(`${name} looks like a flag: ${JSON.stringify(value)}`);
  error2.code = "unsafe_argument";
  error2.argument = name;
  error2.value = value;
  return error2;
}
function assertValueLike(name, value) {
  if (typeof value === "string" && value.startsWith("-")) throw unsafeArgumentError(name, value);
}
function bannedFlagError(banned, argument) {
  const error2 = new Error(`refusing to build argv containing ${JSON.stringify(banned)}`);
  error2.code = "banned_flag";
  error2.banned = banned;
  error2.argument = argument;
  return error2;
}
function assertNoBannedFlags(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const banned of BANNED_EXACT) {
      if (arg === banned) throw bannedFlagError(banned, arg);
    }
    if (arg === "-c" || arg === "--config") {
      const next = String(args[i + 1] ?? "");
      const key = next.slice(0, next.indexOf("="));
      for (const banned of BANNED_CONFIG_KEYS) {
        if (key === banned) throw bannedFlagError(banned, next);
      }
    }
  }
  return args;
}
function buildCodexArgs({
  role,
  model = null,
  effort = null,
  cwd = null,
  skipGitRepoCheck = false
} = {}) {
  const readOnly = READ_ONLY_ROLES2.includes(role);
  const write = WRITE_ROLES2.includes(role);
  if (!readOnly && !write) throw unknownRoleError2(role);
  assertValueLike("model", model);
  assertValueLike("effort", effort);
  assertValueLike("cwd", cwd);
  const args = [...BASE_ARGS2];
  args.push("--sandbox", WORKSPACE_WRITE_ROLES.includes(role) ? "workspace-write" : "read-only");
  if (typeof model === "string" && model !== "") args.push("-m", model);
  if (typeof effort === "string" && effort !== "") args.push("-c", `model_reasoning_effort=${effort}`);
  if (typeof cwd === "string" && cwd !== "") args.push("-C", cwd);
  if (skipGitRepoCheck === true && readOnly) args.push("--skip-git-repo-check");
  return assertNoBannedFlags(args);
}

// src/providers/codex-stream.mjs
var KNOWN_EVENTS = /* @__PURE__ */ new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error"
]);
var KNOWN_ITEMS = /* @__PURE__ */ new Set([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
  "error"
]);
function parseCodexLine(line) {
  let raw;
  try {
    raw = typeof line === "string" ? line : String(line ?? "");
  } catch {
    return { ok: false, raw: "" };
  }
  try {
    const record2 = JSON.parse(raw);
    if (record2 === null || typeof record2 !== "object" || Array.isArray(record2)) return { ok: false, raw };
    return { ok: true, record: record2 };
  } catch {
    return { ok: false, raw };
  }
}
function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}
function readUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: intOrNull(usage.input_tokens),
    cachedInputTokens: intOrNull(usage.cached_input_tokens),
    cacheWriteInputTokens: intOrNull(usage.cache_write_input_tokens),
    outputTokens: intOrNull(usage.output_tokens),
    reasoningOutputTokens: intOrNull(usage.reasoning_output_tokens)
  };
}
function readItem(item) {
  return {
    raw: item,
    id: typeof item.id === "string" ? item.id : null,
    type: item.type,
    text: typeof item.text === "string" ? item.text : null,
    command: typeof item.command === "string" ? item.command : null,
    output: typeof item.aggregated_output === "string" ? item.aggregated_output : null,
    // ★ Option<i32> 인데 skip_serializing_if 가 없어 실행 중에는 실제로 null 이 온다.
    //   0 으로 뭉개면 "성공했다"가 된다.
    exitCode: intOrNull(item.exit_code),
    status: typeof item.status === "string" ? item.status : null,
    message: typeof item.message === "string" ? item.message : null
  };
}
function collectCodexStream(text) {
  const order = [];
  const byId = /* @__PURE__ */ new Map();
  const errors = [];
  const unknownTypes = /* @__PURE__ */ new Set();
  const unparsableLines = [];
  let threadId = null;
  let usage = null;
  let turnStatus = null;
  let lastAnswer = null;
  let source;
  try {
    source = typeof text === "string" ? text : String(text ?? "");
  } catch {
    source = "";
  }
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = parseCodexLine(line);
    if (!parsed.ok) {
      unparsableLines.push(parsed.raw);
      continue;
    }
    const record2 = parsed.record;
    if (!KNOWN_EVENTS.has(record2.type)) {
      unknownTypes.add(String(record2.type));
      continue;
    }
    if (record2.type === "thread.started") {
      threadId = typeof record2.thread_id === "string" ? record2.thread_id : null;
      continue;
    }
    if (record2.type === "turn.completed") {
      turnStatus = "completed";
      usage = readUsage(record2.usage);
      continue;
    }
    if (record2.type === "turn.failed") {
      turnStatus = "failed";
      const message = record2.error?.message;
      if (typeof message === "string") errors.push({ source: "turn.failed", message });
      continue;
    }
    if (record2.type === "error") {
      if (typeof record2.message === "string") errors.push({ source: "error", message: record2.message });
      continue;
    }
    const item = record2.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      unparsableLines.push(line);
      continue;
    }
    if (!KNOWN_ITEMS.has(item.type)) {
      unknownTypes.add(`item:${item.type}`);
      continue;
    }
    const shaped = readItem(item);
    if (record2.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      lastAnswer = item.text;
    }
    if (record2.type === "item.completed" && item.type === "error" && typeof item.message === "string") {
      errors.push({ source: "item", message: item.message });
    }
    const key = shaped.id ?? `${item.type}:${order.length}`;
    if (byId.has(key)) {
      const existing = byId.get(key);
      for (const [k, v] of Object.entries(shaped)) {
        if (v === null || v === void 0) continue;
        if (k === "raw") {
          existing.raw = { ...existing.raw, ...v };
          continue;
        }
        existing[k] = v;
      }
    } else {
      byId.set(key, shaped);
      order.push(shaped);
    }
  }
  return {
    text: lastAnswer ?? "",
    items: order,
    usage,
    threadId,
    errors,
    turnStatus,
    unknownTypes: [...unknownTypes].sort(),
    unparsableLines
  };
}

// src/providers/codex-run.mjs
function runCodex(options = {}) {
  return runCli({ ...options, authNames: CODEX_AUTH_NAMES, collect: collectCodexStream, sendStdin: false });
}

// src/providers/codex.mjs
function extractMessage2(error2) {
  if (typeof error2 === "string") return error2 !== "" ? error2 : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  if (error2 instanceof Error && typeof error2.message === "string" && error2.message !== "") return error2.message;
  if (error2 && typeof error2 === "object" && typeof error2.message === "string" && error2.message !== "") {
    return error2.message;
  }
  if (error2 && typeof error2 === "object") {
    if (Number.isInteger(error2.exitCode)) return `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uC885\uB8CC \uCF54\uB4DC ${error2.exitCode} \uB85C \uB05D\uB0AC\uB2E4`;
    if (typeof error2.code === "string" && error2.code !== "") return error2.code;
  }
  return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
}
function buildFailureError2(runResult) {
  if (runResult.spawnError) return runResult.spawnError;
  const stderr = typeof runResult.stderr === "string" ? runResult.stderr.trim() : "";
  const preferred = runResult.errors?.[0]?.message;
  const message = typeof preferred === "string" && preferred !== "" ? preferred : stderr !== "" ? stderr : void 0;
  return {
    code: "cli_exit_nonzero",
    exitCode: runResult.exitCode,
    stderr: runResult.stderr,
    message
  };
}
function describeError2(error2) {
  try {
    const code = error2 && typeof error2 === "object" ? error2.code : void 0;
    if (code === "cli_not_found") {
      const name = typeof error2.binaryName === "string" && error2.binaryName !== "" ? error2.binaryName : "codex";
      return {
        error: `${name} CLI \uB97C PATH \uC5D0\uC11C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
        recovery: "codex CLI \uB97C \uC124\uCE58\uD558\uACE0 `codex --version` \uC774 \uB3D9\uC791\uD558\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      };
    }
    if (code === "cli_shim_only") {
      const shimPath = typeof error2.shimPath === "string" ? error2.shimPath : "\uACBD\uB85C \uBD88\uBA85";
      return {
        error: `codex CLI \uB294 \uC178 \uC148\uB9CC \uBC1C\uACAC\uB410\uC2B5\uB2C8\uB2E4: ${shimPath}`,
        recovery: `\uB124\uC774\uD2F0\uBE0C codex \uC2E4\uD589 \uD30C\uC77C\uC744 \uC124\uCE58\uD558\uC138\uC694(\uBC1C\uACAC\uB41C \uC148: ${shimPath}). \uC774 \uC800\uC7A5\uC18C\uB294 shell:false \uB85C\uB9CC \uC2A4\uD3F0\uD558\uBBC0\uB85C \uC148\uC744 \uC9C1\uC811 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`
      };
    }
    if (code === "unknown_role" || code === "unsafe_argument" || code === "banned_flag") {
      return {
        error: `\uD638\uCD9C\uBD80 \uBC84\uADF8: ${extractMessage2(error2)}`,
        recovery: "\uB378\uB9AC\uAC8C\uC774\uD2B8 \uD638\uCD9C \uCF54\uB4DC\uC758 role/model/effort/cwd \uAC12\uC744 \uC810\uAC80\uD558\uC138\uC694."
      };
    }
    return {
      error: extractMessage2(error2),
      recovery: "codex \uC2E4\uD589 \uB85C\uADF8(stderr)\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    };
  } catch {
    return { error: "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958", recovery: "codex \uC2E4\uD589 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uC138\uC694." };
  }
}
function toolSetNotice(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  return `codex exec \uC5D0\uB294 \uB3C4\uAD6C \uC9D1\uD569\uC744 \uC881\uD788\uB294 \uD50C\uB798\uADF8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uC694\uCCAD\uD55C \uB3C4\uAD6C \uBAA9\uB85D(${tools.join(", ")})\uC740 \uC774 \uC2E4\uD589\uC5D0 \uC801\uC6A9\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC178\uC740 \uC0B4\uC544 \uC788\uACE0, \uC131\uB9BD\uD558\uB294 \uACBD\uACC4\uB294 --sandbox \uC758 \uD30C\uC77C\uC2DC\uC2A4\uD15C \uBC94\uC704(POSIX) \uC640 \uC77C\uD68C\uC6A9 \uC6CC\uD06C\uD2B8\uB9AC\uBFD0\uC785\uB2C8\uB2E4.`;
}
async function discover2(signal, deps = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? resolveLaunch;
  const runFn = deps.run ?? ((options) => runCli({ ...options, collect: (text) => ({ text }), sendStdin: true }));
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: "codex" });
  } catch (error2) {
    return { reachable: false, ...describeError2(error2) };
  }
  const versionResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ["--version"],
    instruction: "",
    signal,
    authNames: CODEX_AUTH_NAMES
  });
  if (versionResult.spawnError || versionResult.exitCode !== 0 && versionResult.exitCode !== null) {
    return {
      reachable: false,
      ...describeError2(versionResult.spawnError ?? { code: "cli_exit_nonzero", stderr: versionResult.stderr })
    };
  }
  const version2 = typeof versionResult.text === "string" ? versionResult.text.trim() : void 0;
  const modelsResult = await runFn({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args: ["debug", "models"],
    instruction: "",
    signal,
    authNames: CODEX_AUTH_NAMES
  });
  const parsed = parseCodexModels(modelsResult.text ?? "");
  return { reachable: true, version: version2, models: parsed.ok ? parsed.models : [] };
}
async function run2({
  role,
  model = null,
  effort = null,
  instruction = "",
  workspace,
  allowedTools: _allowedTools,
  // codex 는 --allowedTools 개념이 없다. --sandbox 로 갈린다(codex-args.mjs).
  // ★ contract.mjs 의 범용 이름. **codex exec 에는 도구 집합을 좁히는 플래그가 없다**
  //   (캡처된 --help, codex-cli 0.146.1). 갈리는 것은 `--sandbox` 뿐이라, 호출부가
  //   "Bash 없는 집합" 을 요청해도 codex 쪽에서는 그것을 argv 로 표현할 방법이 없다.
  //   조용히 무시하지 않고 아래에서 notice 로 알린다.
  tools,
  signal,
  onProgress,
  onSpawn,
  runId,
  deps = {}
} = {}) {
  const resolveLaunchFn = deps.resolveLaunch ?? resolveLaunch;
  let launch;
  try {
    launch = await resolveLaunchFn({ basename: "codex" });
  } catch (error2) {
    return {
      content: "",
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError2(error2)
    };
  }
  let args;
  try {
    args = deps.args ?? buildCodexArgs({ role, model, effort, cwd: workspace, skipGitRepoCheck: READ_ONLY_ROLES2.includes(role) });
    if (deps.args === void 0 && typeof instruction === "string" && instruction !== "") {
      args = [...args, instruction];
    }
  } catch (error2) {
    return {
      content: "",
      model: model ?? null,
      promptTokens: null,
      evalTokens: null,
      truncated: false,
      doneReason: null,
      // 해당 없을 때도 키는 둔다. 있다가 없다가 하면 호출부가 키 존재로 분기할 때
      // 어긋난다 — doneReason 이 이미 그렇게 하고 있다.
      notice: null,
      ...describeError2(error2)
    };
  }
  const runResult = await runCodex({
    binary: launch.command,
    prefixArgs: launch.prefixArgs,
    args,
    instruction,
    cwd: workspace,
    signal,
    onProgress,
    onSpawn,
    runId
  });
  const truncated = runResult.turnStatus !== "completed" || runResult.timedOut === true || runResult.aborted === true;
  const doneReason = runResult.turnStatus ?? (runResult.timedOut ? "timeout" : runResult.aborted ? "aborted" : null);
  const envelope = {
    content: typeof runResult.text === "string" ? runResult.text : "",
    model: model ?? null,
    promptTokens: runResult.usage?.inputTokens ?? null,
    evalTokens: runResult.usage?.outputTokens ?? null,
    truncated,
    doneReason,
    // codex 는 OS 샌드박스가 있어 샌드박스 격차는 알릴 것이 없다. 다만 호출부가 도구
    // 집합 제한을 요청했는데 이 CLI 에는 그 채널이 없으면 그 사실은 알려야 한다 —
    // 조용히 무시하면 호출부는 워커에게 Bash 가 없다고 믿는다.
    notice: toolSetNotice(tools)
  };
  const failed = runResult.spawnError || runResult.exitCode !== 0 && runResult.exitCode !== null;
  if (failed) {
    Object.assign(envelope, describeError2(buildFailureError2(runResult)));
  }
  return envelope;
}
var codexProvider = {
  id: "codex",
  discover: discover2,
  run: run2,
  describeError: describeError2
};

// src/providers/index.mjs
var REGISTRY = new Map([claudeProvider, codexProvider].map((p) => [assertProviderShape(p).id, p]));
var PROVIDER_IDS = Object.freeze([...REGISTRY.keys()]);
function listProviders() {
  return [...REGISTRY.values()];
}

// src/state-root.mjs
import { homedir } from "node:os";
import { isAbsolute as isAbsolute3, join as join2 } from "node:path";
function resolveStateRoot(env = process.env) {
  const injected = env.BOM_ORCH_HOME;
  if (typeof injected === "string" && injected.trim() !== "" && isAbsolute3(injected)) {
    return injected;
  }
  return join2(homedir(), ".bom-orch");
}

// src/providers/catalog.mjs
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
var FILENAME = "model-catalog.json";
var DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1e3;
var POINT_OF_USE_MAX_AGE_MS = 5 * 60 * 1e3;
async function readCatalog(stateRoot2) {
  try {
    const text = await readFile(join3(stateRoot2, FILENAME), "utf8");
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
async function writeCatalog(stateRoot2, vendorId, models, now = Date.now()) {
  if (!Array.isArray(models) || models.length === 0) return false;
  const run3 = async () => {
    try {
      return await writeOne(stateRoot2, vendorId, models, now);
    } catch {
      return false;
    }
  };
  writeQueue = writeQueue.then(run3, run3);
  return writeQueue;
}
var writeQueue = Promise.resolve();
var tempCounter = 0;
async function writeOne(stateRoot2, vendorId, models, now) {
  let temp;
  try {
    const catalog = await readCatalog(stateRoot2);
    catalog[vendorId] = { models, fetchedAt: new Date(now).toISOString() };
    const target = join3(stateRoot2, FILENAME);
    temp = `${target}.${process.pid}.${tempCounter++}.tmp`;
    await mkdir(stateRoot2, { recursive: true });
    await writeFile(temp, JSON.stringify(catalog, null, 2), "utf8");
    await rename(temp, target);
    return true;
  } catch {
    if (temp !== void 0) await rm(temp, { force: true }).catch(() => {
    });
    return false;
  }
}
function shouldRefresh(catalog, vendorId, maxAgeMs, now = Date.now()) {
  const entry = catalog?.[vendorId];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return true;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return true;
  if (fetchedAt > now) return true;
  return now - fetchedAt >= maxAgeMs;
}

// src/envelope.mjs
var STATUSES = Object.freeze(["succeeded", "failed", "invalid", "blocked", "deadline_exceeded"]);
var CONFIDENCE = Object.freeze(["verified", "unverified", "disputed"]);
var MAX_CONTENT_CHARS = 1e4;
var GENERIC_RECOVERY = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
var TRUNCATION_NOTICE = `content \uAC00 ${MAX_CONTENT_CHARS}\uC790 \uC0C1\uD55C\uC744 \uB118\uC5B4 \uC798\uB838\uC2B5\uB2C8\uB2E4(truncated). \uC804\uCCB4 \uB0B4\uC6A9\uC774 \uD544\uC694\uD558\uBA74 \uB354 \uC881\uC740 \uC694\uCCAD\uC73C\uB85C \uB098\uB220 \uB2E4\uC2DC \uBD80\uB974\uC138\uC694.`;
function safeErrorText(error2) {
  if (typeof error2 === "string") return error2 !== "" ? error2 : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  try {
    const text = String(error2);
    return text !== "" ? text : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  } catch {
    return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  }
}
function normalizeConfidence(confidence) {
  return CONFIDENCE.includes(confidence) ? confidence : "unverified";
}
function success({ content, confidence, notice, ...rest } = {}) {
  const finalConfidence = normalizeConfidence(confidence);
  let finalContent = typeof content === "string" ? content : "";
  let finalNotice = typeof notice === "string" && notice !== "" ? notice : void 0;
  if (finalContent.length > MAX_CONTENT_CHARS) {
    finalContent = finalContent.slice(0, MAX_CONTENT_CHARS);
    finalNotice = finalNotice ? `${finalNotice} ${TRUNCATION_NOTICE}` : TRUNCATION_NOTICE;
  }
  const status = finalConfidence === "disputed" ? "failed" : "succeeded";
  const env = { ...rest, status, content: finalContent, confidence: finalConfidence };
  if (finalNotice !== void 0) env.notice = finalNotice;
  if (status !== "succeeded" && (typeof env.recovery !== "string" || env.recovery === "")) {
    env.recovery = GENERIC_RECOVERY;
  }
  return env;
}
function failure({ status, error: error2, recovery, ...rest } = {}) {
  const finalStatus = STATUSES.includes(status) && status !== "succeeded" ? status : "failed";
  const finalRecovery = typeof recovery === "string" && recovery !== "" ? recovery : GENERIC_RECOVERY;
  return { ...rest, status: finalStatus, error: safeErrorText(error2), recovery: finalRecovery };
}
function stringifyOrThrow(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("\uC9C1\uB82C\uD654 \uACB0\uACFC\uAC00 \uBB38\uC790\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4.");
  return text;
}
var HARD_FALLBACK_TEXT = '{"status":"failed","error":"serialization failed","recovery":"\uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uAD00\uB9AC\uC790\uC5D0\uAC8C \uC54C\uB9AC\uC138\uC694."}';
function serializeToolResult(envelope) {
  try {
    return { content: [{ type: "text", text: stringifyOrThrow(envelope) }] };
  } catch {
    try {
      const fallback = failure({
        status: "failed",
        error: "\uACB0\uACFC \uC9C1\uB82C\uD654\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.",
        recovery: "\uACB0\uACFC\uAC00 \uB108\uBB34 \uD06C\uAC70\uB098 \uC21C\uD658 \uCC38\uC870\uB97C \uB2F4\uACE0 \uC788\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uB354 \uC881\uC740 \uC694\uCCAD\uC73C\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
      });
      return { content: [{ type: "text", text: stringifyOrThrow(fallback) }] };
    } catch {
      return { content: [{ type: "text", text: HARD_FALLBACK_TEXT }] };
    }
  }
}
var TYPE_LABEL = {
  boolean: "boolean(\uBD88\uB9AC\uC5B8)",
  string: "string(\uBB38\uC790\uC5F4)",
  number: "number(\uC22B\uC790)",
  array: "array(\uBC30\uC5F4)"
};
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) table[i][0] = i;
  for (let j = 0; j < cols; j += 1) table[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
    }
  }
  return table[rows - 1][cols - 1];
}
function closestKey(key, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
function validateArgs(args, spec) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {
      ok: false,
      error: "\uC778\uC790\uB294 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.",
      recovery: "{ } \uD615\uD0DC\uC758 \uAC1D\uCCB4\uB85C \uB2E4\uC2DC \uD638\uCD9C\uD558\uC138\uC694."
    };
  }
  const specObj = spec && typeof spec === "object" ? spec : {};
  const specKeys = Object.keys(specObj);
  const argKeys = Object.keys(args);
  const unknown2 = argKeys.filter((key) => !specKeys.includes(key));
  if (unknown2.length > 0) {
    const bad = unknown2[0];
    const suggestion = specKeys.length > 0 ? closestKey(bad, specKeys) : null;
    const allowed = specKeys.length > 0 ? `\uD5C8\uC6A9\uB41C \uC778\uC790: ${specKeys.join(", ")}` : "\uD5C8\uC6A9\uB41C \uC778\uC790\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.";
    return {
      ok: false,
      error: `\uC54C \uC218 \uC5C6\uB294 \uC778\uC790: ${bad}`,
      recovery: suggestion ? `\uD639\uC2DC '${suggestion}' \uB97C \uC758\uB3C4\uD588\uB098\uC694? ${allowed}` : allowed
    };
  }
  const value = {};
  for (const key of specKeys) {
    const fieldSpec = specObj[key] ?? {};
    const provided = Object.hasOwn(args, key);
    if (!provided) {
      if (fieldSpec.required) {
        return {
          ok: false,
          error: `\uD544\uC218 \uC778\uC790 \uB204\uB77D: ${key}`,
          recovery: `'${key}' \uC778\uC790\uB97C \uC9C0\uC815\uD558\uC138\uC694 (${fieldSpec.type ?? "\uAC12"}).`
        };
      }
      if (Object.hasOwn(fieldSpec, "default")) value[key] = fieldSpec.default;
      continue;
    }
    const raw = args[key];
    const expectedType = fieldSpec.type;
    if (expectedType === "array") {
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          error: `'${key}' \uB294 array \uD0C0\uC785\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`,
          recovery: `'${key}' \uC5D0 ${TYPE_LABEL.array} \uAC12\uC744 \uC8FC\uC138\uC694.`
        };
      }
      const itemType = fieldSpec.items;
      if (typeof itemType === "string") {
        const badIndex = raw.findIndex((item) => typeof item !== itemType);
        if (badIndex !== -1) {
          return {
            ok: false,
            error: `'${key}' \uC758 ${badIndex}\uBC88\uC9F8 \uC6D0\uC18C\uAC00 ${itemType} \uAC00 \uC544\uB2D9\uB2C8\uB2E4.`,
            recovery: `'${key}' \uC758 \uBAA8\uB4E0 \uC6D0\uC18C\uB97C ${TYPE_LABEL[itemType] ?? itemType} \uB85C \uC8FC\uC138\uC694.`
          };
        }
      }
      value[key] = raw;
      continue;
    }
    if (typeof expectedType === "string" && typeof raw !== expectedType) {
      return {
        ok: false,
        error: `'${key}' \uB294 ${expectedType} \uD0C0\uC785\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`,
        recovery: `'${key}' \uC5D0 ${TYPE_LABEL[expectedType] ?? expectedType} \uAC12\uC744 \uC8FC\uC138\uC694.`
      };
    }
    if (expectedType === "number") {
      const bad = !Number.isFinite(raw) || fieldSpec.integer === true && !Number.isInteger(raw) || typeof fieldSpec.min === "number" && raw < fieldSpec.min || typeof fieldSpec.max === "number" && raw > fieldSpec.max;
      if (bad) {
        const shape = [
          fieldSpec.integer === true ? "\uC815\uC218" : "\uC720\uD55C\uD55C \uC218",
          typeof fieldSpec.min === "number" ? `${fieldSpec.min} \uC774\uC0C1` : null,
          typeof fieldSpec.max === "number" ? `${fieldSpec.max} \uC774\uD558` : null
        ].filter((part) => part !== null).join(" \xB7 ");
        return {
          ok: false,
          error: `'${key}' \uAC12\uC774 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4: ${safeErrorText(raw)}`,
          recovery: `'${key}' \uC5D0 ${shape} \uC778 \uAC12\uC744 \uC8FC\uC138\uC694.`
        };
      }
    }
    if (Array.isArray(fieldSpec.enum) && !fieldSpec.enum.includes(raw)) {
      return {
        ok: false,
        error: `'${key}' \uAC12\uC774 \uD5C8\uC6A9 \uBAA9\uB85D\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4: ${safeErrorText(raw)}`,
        recovery: `'${key}' \uC5D0 \uB2E4\uC74C \uC911 \uD558\uB098\uB97C \uC4F0\uC138\uC694: ${fieldSpec.enum.join(", ")}`
      };
    }
    value[key] = raw;
  }
  return { ok: true, value };
}

// src/engine.mjs
import { mkdir as mkdir6, rm as rm8, writeFile as writeFile4 } from "node:fs/promises";
import { isAbsolute as isAbsolute13, join as join14 } from "node:path";

// src/config.mjs
import { mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm3, writeFile as writeFile2 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, join as join4 } from "node:path";

// src/lockfile.mjs
import { open, readFile as readFile2, rm as rm2, stat } from "node:fs/promises";
async function withLock(lockPath, fn, options) {
  if (typeof lockPath !== "string" || lockPath === "") {
    return { ok: false, reason: "\uC7A0\uAE08 \uACBD\uB85C\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
  }
  if (typeof fn !== "function") return { ok: false, reason: "\uC7A0\uAE08 \uBCF8\uBB38\uC774 \uD568\uC218\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const { timeoutMs = 5e3, retryMs = 25, staleMs = 6e4 } = options && typeof options === "object" ? options : {};
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5e3);
  const wait = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 25;
  const age = Number.isFinite(staleMs) && staleMs >= 0 ? staleMs : 6e4;
  let handle = null;
  let lastCode = "\uC5C6\uC74C";
  for (; ; ) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error2) {
      const retryable = error2?.code === "EEXIST" || error2?.code === "EPERM" || error2?.code === "EBUSY";
      if (!retryable) return { ok: false, reason: `\uC7A0\uAE08\uC744 \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe2(error2)}` };
      lastCode = error2?.code ?? "\uC54C \uC218 \uC5C6\uC74C";
      if (error2?.code === "EEXIST" && await isStale(lockPath, age)) {
        await rm2(lockPath, { force: true }).catch((error3) => {
          lastCode = error3?.code ?? lastCode;
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { ok: false, reason: `\uC7A0\uAE08\uC744 \uC81C\uD55C \uC2DC\uAC04 \uC548\uC5D0 \uC7A1\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. (\uB9C8\uC9C0\uB9C9 \uC624\uB958: ${lastCode})` };
      }
      await new Promise((r) => setTimeout(r, Math.min(wait, remaining)));
    }
  }
  const token = JSON.stringify({ pid: process.pid, at: Date.now() });
  let wrote = false;
  let outcome;
  try {
    await handle.writeFile(token, "utf8");
    wrote = true;
    const value = await fn();
    outcome = { ok: true, value };
  } catch (error2) {
    outcome = wrote ? { ok: false, reason: `\uBCF8\uBB38\uC774 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: ${describe2(error2)}` } : { ok: false, reason: `\uC7A0\uAE08 \uD45C\uC2DD\uC744 \uC4F0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe2(error2)}` };
  }
  const notes = [];
  const closeFailure = await handle.close().then(
    () => null,
    (error2) => describe2(error2)
  );
  if (closeFailure) notes.push(`\uC7A0\uAE08 \uD30C\uC77C \uD578\uB4E4\uC744 \uB2EB\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4(fd \uB204\uC218): ${closeFailure}`);
  const release = await releaseOwnLock(lockPath, wrote ? token : "");
  if (release.reason) notes.push(release.reason);
  const result = { ...outcome, released: release.released };
  if (notes.length > 0) result.releaseReason = notes.join(" / ");
  return result;
}
async function releaseOwnLock(lockPath, token) {
  let raw;
  try {
    raw = await readFile2(lockPath, "utf8");
  } catch (error2) {
    if (error2?.code === "ENOENT") {
      return { released: true };
    }
    return { released: false, reason: `\uC7A0\uAE08 \uD30C\uC77C\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD574 \uC9C0\uC6B0\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${describe2(error2)}` };
  }
  if (raw !== token) {
    return { released: false, reason: "\uC7A0\uAE08 \uD30C\uC77C\uC774 \uC6B0\uB9AC\uAC00 \uC4F4 \uAC83\uACFC \uB2EC\uB77C \uC9C0\uC6B0\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4 \u2014 \uB2E4\uB978 \uCABD\uC774 \uAC00\uC838\uAC14\uC2B5\uB2C8\uB2E4." };
  }
  try {
    await rm2(lockPath, { force: true });
    return { released: true };
  } catch (error2) {
    return { released: false, reason: `\uC7A0\uAE08 \uD30C\uC77C\uC744 \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe2(error2)}` };
  }
}
function describe2(error2) {
  if (error2 === void 0) return "\uC0AC\uC720 \uC5C6\uC774 undefined \uAC00 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  if (error2 === null) return "\uC0AC\uC720 \uC5C6\uC774 null \uC774 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  try {
    const message = error2?.message;
    if (typeof message === "string" && message !== "") return message;
    return String(error2);
  } catch {
    return "\uC0AC\uC720\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  }
}
async function isStale(lockPath, staleMs) {
  try {
    const raw = await readFile2(lockPath, "utf8");
    const at = JSON.parse(raw)?.at;
    if (Number.isFinite(at)) return Date.now() - at > staleMs;
  } catch {
  }
  try {
    const { mtimeMs } = await stat(lockPath);
    return Number.isFinite(mtimeMs) && Date.now() - mtimeMs > staleMs;
  } catch {
    return false;
  }
}

// src/config.mjs
var FILENAME2 = "settings.ini";
var LOCKNAME = "settings.lock";
var VENDORS = Object.freeze(["claude", "codex"]);
var TIERS = Object.freeze(["strong", "fast"]);
var TIER_FIELDS = Object.freeze(
  Object.fromEntries(TIERS.flatMap((tier) => [[tier, tier], [`${tier}Effort`, `${tier}_effort`]]))
);
var INI_KEY_TIER = Object.freeze(
  Object.fromEntries(TIERS.flatMap((tier) => [[tier, tier], [`${tier}_effort`, tier]]))
);
var SECTION_HEADER = /^\[([^\]]*)\]/;
function parseIni(text) {
  const sections = /* @__PURE__ */ Object.create(null);
  let section = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const match = SECTION_HEADER.exec(line);
      const name = match ? match[1].trim() : "";
      section = name === "" ? null : name;
      if (section !== null && sections[section] === void 0) sections[section] = /* @__PURE__ */ Object.create(null);
      continue;
    }
    if (section === null) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== "" && value !== "") sections[section][key] = value;
  }
  for (const name of Object.keys(sections)) sections[name] = { ...sections[name] };
  return { ...sections };
}
function tierConfig(section) {
  const source = section && typeof section === "object" ? section : {};
  const config2 = {};
  for (const [field, iniKey] of Object.entries(TIER_FIELDS)) config2[field] = source[iniKey] ?? null;
  return config2;
}
function toSettings(ini) {
  const settings = {};
  for (const vendor of VENDORS) settings[vendor] = tierConfig(ini[vendor]);
  return settings;
}
async function readSettings(stateRoot2) {
  let ini = {};
  try {
    ini = parseIni(await readFile3(join4(stateRoot2, FILENAME2), "utf8"));
  } catch {
  }
  return toSettings(ini);
}
function resolveTier(settings, vendorId, tier) {
  const config2 = settings?.[vendorId];
  if (!config2) return { model: null, effort: null };
  const name = TIERS.includes(tier) ? tier : TIERS[0];
  return { model: config2[name] ?? null, effort: config2[`${name}Effort`] ?? null };
}
function validateSelection(models, model, effort) {
  if (model === null || model === void 0 || effort === null || effort === void 0) return { ok: true };
  const entry = Array.isArray(models) ? models.find((m) => m.name === model) : void 0;
  if (!entry || !Array.isArray(entry.efforts) || entry.efforts.length === 0) return { ok: true };
  if (entry.efforts.includes(effort)) return { ok: true };
  return {
    ok: false,
    error: `model '${model}' does not support effort '${effort}'`,
    recovery: `'${model}' \uC774 \uC9C0\uC6D0\uD558\uB294 effort: ${entry.efforts.join(", ")}. \uADF8\uC911 \uD558\uB098\uB97C \uACE0\uB974\uAC70\uB098 effort \uB97C \uBE44\uC6CC CLI \uAE30\uBCF8\uAC12\uC744 \uC4F0\uC138\uC694.`
  };
}
var REJECT_RECOVERY = "orch_config \uB97C \uC778\uC790 \uC5C6\uC774 \uBD88\uB7EC \uC4F8 \uC218 \uC788\uB294 \uBCA4\uB354\xB7\uD2F0\uC5B4\xB7\uBAA8\uB378\uC744 \uD655\uC778\uD558\uC138\uC694.";
function reject(error2, recovery = REJECT_RECOVERY) {
  return { ok: false, error: error2, recovery };
}
function normalizePatch(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return reject("\uC124\uC815 \uC870\uAC01\uC774 \uAC1D\uCCB4\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  }
  const entries = [];
  for (const vendor of Object.keys(patch)) {
    if (!VENDORS.includes(vendor)) {
      return reject(`\uC124\uC815\uD560 \uC218 \uC5C6\uB294 \uBCA4\uB354\uC785\uB2C8\uB2E4: ${vendor}`, `\uC4F8 \uC218 \uC788\uB294 \uBCA4\uB354: ${VENDORS.join(", ")}`);
    }
    const fields = patch[vendor];
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      return reject(`[${vendor}] \uC758 \uAC12\uC774 \uAC1D\uCCB4\uAC00 \uC544\uB2D9\uB2C8\uB2E4.`);
    }
    const normalized = {};
    for (const field of Object.keys(fields)) {
      if (!Object.hasOwn(TIER_FIELDS, field)) {
        return reject(
          `[${vendor}] \uC5D0 \uC124\uC815\uD560 \uC218 \uC5C6\uB294 \uD0A4\uC785\uB2C8\uB2E4: ${field}`,
          `\uC4F8 \uC218 \uC788\uB294 \uD0A4: ${Object.keys(TIER_FIELDS).join(", ")}`
        );
      }
      const raw = fields[field];
      if (raw === null || raw === void 0) {
        normalized[TIER_FIELDS[field]] = null;
        continue;
      }
      if (typeof raw !== "string") {
        return reject(`[${vendor}] ${field} \uB294 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`);
      }
      if (/[\r\n\u0000]/.test(raw)) {
        return reject(`[${vendor}] ${field} \uAC12\uC5D0 \uAC1C\uD589\uC774\uB098 NUL \uC774 \uB4E4\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.`);
      }
      const trimmed = raw.trim();
      normalized[TIER_FIELDS[field]] = trimmed === "" ? null : trimmed;
    }
    if (Object.keys(normalized).length > 0) entries.push([vendor, normalized]);
  }
  if (entries.length === 0) return reject("\uBC14\uAFC0 \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  return { ok: true, entries };
}
function validateMerged(ini, entries, models) {
  for (const [vendor, fields] of entries) {
    const list = models && Array.isArray(models[vendor]) ? models[vendor] : null;
    if (list === null) continue;
    const merged = { ...ini[vendor] ?? {} };
    for (const [iniKey, value] of Object.entries(fields)) {
      if (value === null) delete merged[iniKey];
      else merged[iniKey] = value;
    }
    for (const tier of new Set(Object.keys(fields).map((iniKey) => INI_KEY_TIER[iniKey]))) {
      const model = merged[TIER_FIELDS[tier]] ?? null;
      const effort = merged[TIER_FIELDS[`${tier}Effort`]] ?? null;
      const verdict = validateSelection(list, model, effort);
      if (!verdict.ok) return reject(`[${vendor}] ${tier}: ${verdict.error}`, verdict.recovery);
    }
  }
  return { ok: true };
}
function splitLines(text) {
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n)/g;
  let consumed = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    lines.push({ text: match[1], eol: match[2] });
    consumed = pattern.lastIndex;
  }
  if (consumed < text.length) lines.push({ text: text.slice(consumed), eol: "" });
  return lines;
}
function headerNameOf(trimmed) {
  const match = SECTION_HEADER.exec(trimmed);
  const name = match ? match[1].trim() : "";
  return name === "" ? null : name;
}
function keyNameOf(trimmed) {
  if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("#") || trimmed.startsWith("[")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  return key === "" ? null : key;
}
function patchIniText(text, entries) {
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== "")?.eol ?? "\n";
  const owner = new Array(lines.length).fill(null);
  let section = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].text.trim();
    if (trimmed.startsWith("[")) {
      section = headerNameOf(trimmed);
      owner[i] = section;
      continue;
    }
    owner[i] = section;
  }
  const replaced = /* @__PURE__ */ new Map();
  const removed = /* @__PURE__ */ new Set();
  const inserted = /* @__PURE__ */ new Map();
  const appended = [];
  for (const [vendor, fields] of entries) {
    const own = [];
    for (let i = 0; i < lines.length; i += 1) if (owner[i] === vendor) own.push(i);
    let insertAfter = null;
    for (const i of own) if (lines[i].text.trim() !== "") insertAfter = i;
    let headerAppended = false;
    for (const [iniKey, value] of Object.entries(fields)) {
      const hits = own.filter((i) => keyNameOf(lines[i].text.trim()) === iniKey);
      if (value === null) {
        for (const i of hits) removed.add(i);
        continue;
      }
      if (hits.length > 0) {
        const target = hits[hits.length - 1];
        const indent = /^[ \t]*/.exec(lines[target].text)[0];
        replaced.set(target, `${indent}${iniKey} = ${value}`);
        continue;
      }
      if (insertAfter === null) {
        if (!headerAppended) {
          appended.push(`[${vendor}]`);
          headerAppended = true;
        }
        appended.push(`${iniKey} = ${value}`);
        continue;
      }
      if (!inserted.has(insertAfter)) inserted.set(insertAfter, []);
      inserted.get(insertAfter).push(`${iniKey} = ${value}`);
    }
  }
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!removed.has(i)) {
      const body = replaced.has(i) ? replaced.get(i) : lines[i].text;
      out.push(body + (lines[i].eol === "" ? eol : lines[i].eol));
    }
    for (const extra of inserted.get(i) ?? []) out.push(extra + eol);
  }
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push(eol);
    for (const extra of appended) out.push(extra + eol);
  }
  return out.join("");
}
var tempCounter2 = 0;
async function writeSettings(stateRoot2, patch, { models = null } = {}) {
  if (typeof stateRoot2 !== "string" || stateRoot2 === "" || !isAbsolute4(stateRoot2)) {
    return reject("\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4.", "BOM_ORCH_HOME \uC744 \uC808\uB300 \uACBD\uB85C\uB85C \uB450\uAC70\uB098 \uBE44\uC6CC \uB450\uC138\uC694.");
  }
  const normalized = normalizePatch(patch);
  if (!normalized.ok) return normalized;
  const file = join4(stateRoot2, FILENAME2);
  try {
    await mkdir2(stateRoot2, { recursive: true });
  } catch (error2) {
    return reject(`\uC0C1\uD0DC \uB514\uB809\uD130\uB9AC\uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${error2?.message ?? error2}`, "\uACBD\uB85C \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694.");
  }
  const held = await withLock(join4(stateRoot2, LOCKNAME), async () => {
    const raw = await readFile3(file, "utf8").catch(() => "");
    const ini = parseIni(raw);
    const verdict = validateMerged(ini, normalized.entries, models);
    if (!verdict.ok) return verdict;
    const next = patchIniText(raw, normalized.entries);
    if (next === raw) return { ok: true, settings: toSettings(ini) };
    const temp = `${file}.${process.pid}.${tempCounter2++}.tmp`;
    try {
      await writeFile2(temp, next, "utf8");
      await rename2(temp, file);
    } catch (error2) {
      await rm3(temp, { force: true }).catch(() => {
      });
      throw error2;
    }
    return { ok: true, settings: toSettings(parseIni(next)) };
  });
  if (!held.ok) {
    const bodyFailed = typeof held.reason === "string" && held.reason.startsWith("\uBCF8\uBB38\uC774");
    return reject(
      held.reason,
      bodyFailed ? "settings.ini \uC758 \uB0B4\uC6A9\uACFC \uACBD\uB85C \uAD8C\uD55C\xB7\uB514\uC2A4\uD06C \uC5EC\uC720\uB97C \uD655\uC778\uD558\uC138\uC694. \uACBD\uD569\uC774 \uC544\uB2C8\uB77C \uC4F0\uAE30 \uC790\uCCB4\uAC00 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4." : "\uB2E4\uB978 \uD504\uB85C\uC138\uC2A4\uAC00 \uC124\uC815\uC744 \uC4F0\uB294 \uC911\uC77C \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694 \u2014 \uC124\uC815 \uD30C\uC77C\uC740 \uBC14\uB00C\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    );
  }
  if (held.released === false && held.value.ok) {
    return { ...held.value, notice: `\uC124\uC815 \uC7A0\uAE08\uC774 \uB0A8\uC558\uC2B5\uB2C8\uB2E4: ${held.releaseReason ?? "\uC0AC\uC720 \uBD88\uBA85"}` };
  }
  return held.value;
}

// src/deadline.mjs
var MAX_TIMEOUT_MS = 2147483647;
function timeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return void 0;
  return AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, MAX_TIMEOUT_MS))));
}

// src/git.mjs
import { spawn as spawn2 } from "node:child_process";
import { mkdir as mkdir3, stat as stat2 } from "node:fs/promises";
import { isAbsolute as isAbsolute5, join as join5 } from "node:path";
var STATE_ROOT = resolveStateRoot();
var { defineProperty } = Object;
var NativePromise = Promise;
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";
var cachedGitPath = null;
function resolveGitPath() {
  if (cachedGitPath !== null) return cachedGitPath;
  let resolved;
  try {
    resolved = resolveBinary({ basename: "git" });
  } catch {
    return null;
  }
  if (typeof resolved !== "string" || !isAbsolute5(resolved)) return null;
  cachedGitPath = resolved;
  return cachedGitPath;
}
var EMPTY_HOOKS_DIR = join5(STATE_ROOT, "git-empty-hooks");
var hooksDirReady = null;
function ensureEmptyHooksDir() {
  if (hooksDirReady === null) {
    hooksDirReady = (async () => {
      try {
        await mkdir3(EMPTY_HOOKS_DIR, { recursive: true });
      } catch {
      }
    })();
  }
  return hooksDirReady;
}
var HARDENING_ARGS = Object.freeze([
  "-c",
  "core.fsmonitor=",
  "-c",
  `core.hooksPath=${EMPTY_HOOKS_DIR}`,
  "-c",
  "core.symlinks=false",
  "-c",
  "core.attributesFile="
]);
var SUBCOMMAND_HARDENING = /* @__PURE__ */ new Map([
  ["diff", Object.freeze(["--no-ext-diff", "--no-textconv", "--no-color", "--default-prefix", "-U3"])],
  ["log", Object.freeze(["--no-textconv", "--no-color"])],
  ["show", Object.freeze(["--no-textconv", "--no-color"])],
  // ★ `blame` 에는 `--no-color` 를 넣지 않는다 — 아래 주석의 실측을 보라(exit 129).
  ["blame", Object.freeze(["--no-textconv"])]
]);
var DEFAULT_TIMEOUT_MS2 = 3e4;
var KILL_GRACE_MS2 = 2e3;
var MAX_ARGS = 4096;
var SAFE_LEADING_OPTIONS = /* @__PURE__ */ new Set([
  "--version",
  "-v",
  "--no-pager",
  "-P",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--no-advice"
]);
var GIT_REDIRECT_VARS = /* @__PURE__ */ new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_ATTR_SOURCE",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_DATE"
]);
var GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;
function isGitRedirectVar(name) {
  const upper = name.toUpperCase();
  return GIT_REDIRECT_VARS.has(upper) || GIT_CONFIG_PAIR.test(upper);
}
var MAX_REASON_TOKEN = 60;
function summarizeToken(token) {
  const eq = token.indexOf("=");
  const head = eq === -1 ? token : `${token.slice(0, eq)}=\u2026`;
  const escaped = head.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return escaped.length <= MAX_REASON_TOKEN ? escaped : `${escaped.slice(0, MAX_REASON_TOKEN)}\u2026`;
}
function screenArgs(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (typeof tokens[i] !== "string") {
      return `git \uC778\uC790\uB294 \uC804\uBD80 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4 \u2014 ${i}\uBC88\uC9F8 \uC6D0\uC18C\uAC00 ${typeof tokens[i]} \uB77C\uC11C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`;
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token[0] !== "-") break;
    if (!SAFE_LEADING_OPTIONS.has(token)) {
      return `\uD5C8\uC6A9 \uBAA9\uB85D\uC5D0 \uC5C6\uB294 \uC120\uD589 \uC804\uC5ED \uC635\uC158\uC774\uB77C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4: ${summarizeToken(token)}`;
    }
  }
  return null;
}
function findSubcommandIndex(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i][0] !== "-") return i;
  }
  return -1;
}
function put(target, index, value) {
  defineProperty(target, index, { value, writable: true, enumerable: true, configurable: true });
}
function rejected(reason) {
  return { ok: false, stdout: "", stderr: reason, exitCode: null, failed: true, timedOut: false };
}
async function runGit(options = {}) {
  await ensureEmptyHooksDir();
  const gitPath = resolveGitPath();
  if (gitPath === null) {
    return rejected("git \uC2E4\uD589 \uD30C\uC77C\uC744 PATH \uC5D0\uC11C \uC808\uB300 \uACBD\uB85C\uB85C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC548\uC804\uD558\uAC8C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.");
  }
  let finalTimeout = DEFAULT_TIMEOUT_MS2;
  let child;
  let finalCwd;
  try {
    const opts = options ?? {};
    const args = opts.args;
    const cwd = opts.cwd;
    const timeoutMs = opts.timeoutMs;
    const env = opts.env;
    finalTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS2;
    if (env !== void 0 && env !== null && (typeof env !== "object" || Array.isArray(env))) {
      return rejected(
        `git \uD658\uACBD \uBCC0\uC218(env)\uB294 \uD3C9\uBC94\uD55C \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4 \u2014 ${Array.isArray(env) ? "array" : typeof env} \uB97C \uBC1B\uC544 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`
      );
    }
    const childEnv = {};
    for (const key of Object.keys(process.env)) {
      if (isGitRedirectVar(key)) continue;
      const value = process.env[key];
      if (typeof value === "string") childEnv[key] = value;
    }
    if (env !== void 0 && env !== null) {
      for (const key of Object.keys(env)) {
        const value = env[key];
        if (typeof value !== "string") {
          return rejected(
            `git \uD658\uACBD \uBCC0\uC218(env)\uC758 \uAC12\uC740 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4 \u2014 ${summarizeToken(key)} \uAC00 ${value === null ? "null" : typeof value} \uB77C\uC11C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`
          );
        }
        childEnv[key] = value;
      }
    }
    if (cwd !== void 0 && (typeof cwd !== "string" || cwd === "")) {
      return rejected(
        `git \uC791\uC5C5 \uB514\uB809\uD130\uB9AC(cwd)\uB294 \uBE44\uC5B4 \uC788\uC9C0 \uC54A\uC740 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4 \u2014 ${cwd === null ? "null" : typeof cwd} \uB97C \uBC1B\uC544 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`
      );
    }
    if (cwd !== void 0 && !isAbsolute5(cwd)) {
      return rejected("git \uC791\uC5C5 \uB514\uB809\uD130\uB9AC(cwd)\uB294 \uC808\uB300 \uACBD\uB85C\uC5EC\uC57C \uD569\uB2C8\uB2E4 \u2014 \uC0C1\uB300 \uACBD\uB85C\uB97C \uBC1B\uC544 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4");
    }
    finalCwd = cwd;
    if (args !== void 0 && !Array.isArray(args)) {
      return rejected(`git \uC778\uC790\uB294 \uBC30\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4 \u2014 ${args === null ? "null" : typeof args} \uB97C \uBC1B\uC544 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`);
    }
    const finalArgs = args === void 0 ? [] : args;
    const length = finalArgs.length;
    if (!Number.isInteger(length) || length < 0) {
      return rejected(`git \uC778\uC790 \uBC30\uC5F4\uC758 length \uAC00 \uC815\uC218\uAC00 \uC544\uB2C8\uB77C\uC11C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4 (${typeof length})`);
    }
    if (length > MAX_ARGS) {
      return rejected(`git \uC778\uC790\uAC00 \uB108\uBB34 \uB9CE\uC2B5\uB2C8\uB2E4 \u2014 \uCD5C\uB300 ${MAX_ARGS}\uAC1C\uC778\uB370 ${length}\uAC1C\uB97C \uBC1B\uC544 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4`);
    }
    const tokens = [];
    for (let i = 0; i < length; i += 1) put(tokens, i, finalArgs[i]);
    const rejection = screenArgs(tokens);
    if (rejection) return rejected(rejection);
    const subcommandIndex = findSubcommandIndex(tokens);
    const argv = [];
    let n = 0;
    for (let i = 0; i < HARDENING_ARGS.length; i += 1) put(argv, n++, HARDENING_ARGS[i]);
    for (let i = 0; i < length; i += 1) {
      put(argv, n++, tokens[i]);
      if (i === subcommandIndex) {
        const extra = SUBCOMMAND_HARDENING.get(tokens[i]);
        if (extra !== void 0) for (let k = 0; k < extra.length; k += 1) put(argv, n++, extra[k]);
      }
    }
    child = spawn2(gitPath, argv, {
      cwd: finalCwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    return rejected("git \uC778\uC790\uB97C \uAC80\uC0AC\uD558\uAC70\uB098 \uD504\uB85C\uC138\uC2A4\uB97C \uB744\uC6B0\uB294 \uC911\uC5D0 \uC608\uC678\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4 \u2014 \uC548\uC804\uD558\uAC8C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.");
  }
  return await new NativePromise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let hardTimer = null;
    const settle2 = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      resolvePromise(value);
    };
    child.on("error", () => {
      settle2({ ok: false, stdout, stderr, exitCode: null, failed: true, timedOut });
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
      }
      hardTimer = setTimeout(() => {
        settle2({
          ok: false,
          stdout,
          stderr: `${stderr}
git \uD504\uB85C\uC138\uC2A4\uAC00 \uD0C0\uC784\uC544\uC6C3 \uB4A4 kill \uC5D0\uB3C4 \uC751\uB2F5\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4 \u2014 \uC790\uC2DD\uC774 \uC544\uC9C1 \uC0B4\uC544 \uC788\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,
          exitCode: null,
          failed: true,
          timedOut: true
        });
      }, KILL_GRACE_MS2);
    }, finalTimeout);
    child.on("close", (code) => {
      const cutShort = code !== 0;
      settle2({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        failed: false,
        timedOut: timedOut && cutShort
      });
    });
  });
}
var MIN_GIT_VERSION = "2.45.1";
var MIN_GIT_VERSION_TUPLE = [2, 45, 1];
var GENERIC_RECOVERY2 = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
function blocked({ error: error2, recovery, choices }) {
  const env = { blocked: true, error: error2, recovery: recovery && recovery !== "" ? recovery : GENERIC_RECOVERY2 };
  if (Array.isArray(choices)) env.choices = choices;
  return env;
}
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(typeof text === "string" ? text : "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function isVersionAtLeast(version2, floor) {
  for (let i = 0; i < floor.length; i += 1) {
    const v = version2[i] ?? 0;
    const f = floor[i];
    if (v > f) return true;
    if (v < f) return false;
  }
  return true;
}
async function checkGitVersion(overrideVersion) {
  let versionText = typeof overrideVersion === "string" && overrideVersion !== "" ? overrideVersion : null;
  if (versionText === null) {
    const got = await runGit({ args: ["--version"] });
    if (!got.ok) {
      return blocked({
        error: "git \uBC84\uC804\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
        recovery: "git \uC774 PATH \uC5D0 \uC124\uCE58\uB418\uC5B4 \uC788\uACE0 \uC2E4\uD589 \uAC00\uB2A5\uD55C\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      });
    }
    versionText = got.stdout;
  }
  const parsed = parseVersion(versionText);
  if (!parsed || !isVersionAtLeast(parsed, MIN_GIT_VERSION_TUPLE)) {
    return blocked({
      error: `git \uBC84\uC804\uC774 \uB108\uBB34 \uB0AE\uC2B5\uB2C8\uB2E4 (${versionText.trim() || "\uC54C \uC218 \uC5C6\uC74C"}). \uCD5C\uC18C git ${MIN_GIT_VERSION} \uC774\uC0C1\uC774 \uD544\uC694\uD569\uB2C8\uB2E4 (CVE-2024-32002: \uB300\uC18C\uBB38\uC790\uB97C \uAD6C\uBD84\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C\uC2DC\uC2A4\uD15C\uC5D0\uC11C \uC2EC\uBCFC\uB9AD \uB9C1\uD06C \uAC80\uC0AC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4).`,
      recovery: `git \uC744 ${MIN_GIT_VERSION} \uC774\uC0C1\uC73C\uB85C \uC5C5\uADF8\uB808\uC774\uB4DC\uD558\uC138\uC694.`
    });
  }
  return null;
}
async function inspectRepo(projectPath, opts = {}) {
  if (typeof projectPath !== "string" || projectPath === "") {
    return blocked({
      error: "\uD504\uB85C\uC81D\uD2B8 \uACBD\uB85C\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.",
      recovery: "\uC808\uB300 \uACBD\uB85C\uB97C \uC9C0\uC815\uD558\uC138\uC694."
    });
  }
  try {
    await stat2(projectPath);
  } catch {
    return blocked({
      error: `\uACBD\uB85C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${projectPath}`,
      recovery: "\uD504\uB85C\uC81D\uD2B8 \uACBD\uB85C\uAC00 \uC62C\uBC14\uB978 \uC808\uB300 \uACBD\uB85C\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694."
    });
  }
  const versionBlocked = await checkGitVersion(opts?.gitVersion);
  if (versionBlocked) return versionBlocked;
  const gitDir = await runGit({ args: ["rev-parse", "--git-dir"], cwd: projectPath });
  if (!gitDir.ok) {
    return blocked({
      error: `git \uC800\uC7A5\uC18C\uAC00 \uC544\uB2D9\uB2C8\uB2E4: ${projectPath}`,
      recovery: "`git init` \uC73C\uB85C \uC800\uC7A5\uC18C\uB97C \uB9CC\uB4E4\uAC70\uB098 \uC62C\uBC14\uB978 \uD504\uB85C\uC81D\uD2B8 \uACBD\uB85C\uB97C \uC9C0\uC815\uD558\uC138\uC694."
    });
  }
  const head = await runGit({ args: ["rev-parse", "--verify", "HEAD"], cwd: projectPath });
  if (!head.ok) {
    return blocked({
      error: "HEAD \uAC00 \uAC00\uB9AC\uD0A4\uB294 \uCEE4\uBC0B\uC774 \uC5C6\uC2B5\uB2C8\uB2E4 (\uBE48 \uC800\uC7A5\uC18C\uC774\uAC70\uB098 unborn \uBE0C\uB79C\uCE58\uC785\uB2C8\uB2E4). \uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
      recovery: "\uC544\uB798 \uC120\uD0DD\uC9C0 \uC911 \uD558\uB098\uB97C \uACE0\uB974\uC138\uC694.",
      choices: [
        '\uCEE4\uBC0B\uC744 \uCD5C\uC18C 1\uAC1C \uB9CC\uB4E0 \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD55C\uB2E4 (`git commit --allow-empty -m "init"` \uB3C4 \uB41C\uB2E4)',
        "\uC774 \uC800\uC7A5\uC18C\uC5D0\uC11C\uB294 \uC2E4\uD589\uD558\uC9C0 \uC54A\uB294\uB2E4 \u2014 \uCEE4\uBC0B\uC774 \uC788\uB294 \uB2E4\uB978 \uACBD\uB85C\uB97C project \uB85C \uC900\uB2E4"
      ]
    });
  }
  return { ok: true };
}

// src/learn/posteriors.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { open as open3, readFile as readFile5, rename as rename4, rm as rm5 } from "node:fs/promises";
import { isAbsolute as isAbsolute7, join as join7 } from "node:path";

// src/learn/learning.mjs
import { randomUUID } from "node:crypto";
import { open as open2, readFile as readFile4, rename as rename3, rm as rm4, stat as stat3 } from "node:fs/promises";
import { isAbsolute as isAbsolute6, join as join6 } from "node:path";
var LEARNING_LOCK_FILE = "learning.lock";
var PENDING_FILE = "learning.pending.json";
var GENERATIONS_FILE = "learning.generations.json";
var RENAME_TRIES = 10;
var RENAME_WAIT_MS = 5;
var RECOVERY_FAILURE = /* @__PURE__ */ Symbol("recovery-failure");
var pathsFor = (stateRoot2) => typeof stateRoot2 === "string" && stateRoot2 !== "" && isAbsolute6(stateRoot2) ? {
  root: stateRoot2,
  lock: join6(stateRoot2, LEARNING_LOCK_FILE),
  pending: join6(stateRoot2, PENDING_FILE),
  posteriors: join6(stateRoot2, "posteriors.json"),
  generations: join6(stateRoot2, GENERATIONS_FILE),
  journal: join6(stateRoot2, "journal.jsonl")
} : null;
function generationOf(generations, cellKey) {
  const global = Number.isInteger(generations?.global) && generations.global >= 0 ? generations.global : 0;
  const local = Number.isInteger(generations?.cells?.[cellKey]) && generations.cells[cellKey] >= 0 ? generations.cells[cellKey] : 0;
  return Math.max(global, local);
}
function normalizeGenerations(raw) {
  const global = Number.isInteger(raw?.global) && raw.global >= 0 ? raw.global : 0;
  const cells = {};
  if (raw?.cells !== null && typeof raw?.cells === "object" && !Array.isArray(raw.cells)) {
    for (const [key, value] of Object.entries(raw.cells)) {
      if (Number.isInteger(value) && value >= 0) cells[key] = value;
    }
  }
  return { global, cells };
}
async function readGenerationsUnlocked(stateRoot2) {
  const paths = pathsFor(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  try {
    const raw = JSON.parse(await readFile4(paths.generations, "utf8"));
    return { ok: true, generations: normalizeGenerations(raw) };
  } catch (error2) {
    if (error2?.code === "ENOENT") return { ok: true, generations: { global: 0, cells: {} } };
    return { ok: false, reason: `\uD559\uC2B5 \uC138\uB300\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
}
async function withLearningLock(stateRoot2, fn) {
  const paths = pathsFor(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const locked = await withLock(paths.lock, async () => {
    const recovered = await recoverPendingUnlocked(paths);
    if (!recovered.ok) return { [RECOVERY_FAILURE]: true, reason: recovered.reason };
    return fn(paths);
  });
  if (locked.ok && locked.value?.[RECOVERY_FAILURE] === true) {
    return { ok: false, reason: locked.value.reason };
  }
  return locked;
}
async function recoverLearning(stateRoot2) {
  const locked = await withLearningLock(stateRoot2, async () => ({ ok: true }));
  if (!locked.ok) return { ok: false, reason: locked.reason };
  return locked.value;
}
async function hasPendingLearningOperation(stateRoot2) {
  const paths = pathsFor(stateRoot2);
  if (paths === null) return false;
  try {
    return (await stat3(paths.pending)).isFile();
  } catch {
    return false;
  }
}
async function commitLearningOperationUnlocked(stateRoot2, operation, { onPhase } = {}) {
  const paths = pathsFor(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const normalized = normalizeOperation(operation);
  if (!normalized.ok) return normalized;
  const written = await writeAtomicJson(paths, paths.pending, PENDING_FILE, normalized.operation);
  if (!written.ok) return written;
  const afterPending = await phase(onPhase, "after-pending");
  if (!afterPending.ok) return afterPending;
  return applyPendingUnlocked(paths, normalized.operation, onPhase);
}
var makeOperationId = () => randomUUID();
async function recoverPendingUnlocked(paths) {
  let raw;
  try {
    raw = JSON.parse(await readFile4(paths.pending, "utf8"));
  } catch (error2) {
    if (error2?.code === "ENOENT") return { ok: true };
    return { ok: false, reason: `\uBCF4\uB958 \uC911\uC778 \uD559\uC2B5 \uC791\uC5C5\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
  const normalized = normalizeOperation(raw);
  if (!normalized.ok) return { ok: false, reason: `\uBCF4\uB958 \uC911\uC778 \uD559\uC2B5 \uC791\uC5C5\uC774 \uC190\uC0C1\uB410\uC2B5\uB2C8\uB2E4: ${normalized.reason}` };
  return applyPendingUnlocked(paths, normalized.operation);
}
async function applyPendingUnlocked(paths, operation, onPhase) {
  const { targets } = operation;
  if (targets.quarantine !== null) {
    const quarantined = await writeAtomicBytes(
      paths,
      join6(paths.root, targets.quarantine.file),
      targets.quarantine.file,
      Buffer.from(targets.quarantine.bytes, "base64")
    );
    if (!quarantined.ok) return quarantined;
  }
  const afterQuarantine = await phase(onPhase, "after-quarantine");
  if (!afterQuarantine.ok) return afterQuarantine;
  if (targets.posteriors !== null) {
    const posteriors = await writeAtomicJson(paths, paths.posteriors, "posteriors.json", targets.posteriors);
    if (!posteriors.ok) return posteriors;
  }
  const afterPosterior = await phase(onPhase, "after-posterior");
  if (!afterPosterior.ok) return afterPosterior;
  if (targets.generations !== null) {
    const generations = await writeAtomicJson(paths, paths.generations, GENERATIONS_FILE, targets.generations);
    if (!generations.ok) return generations;
  }
  const afterGenerations = await phase(onPhase, "after-generations");
  if (!afterGenerations.ok) return afterGenerations;
  if (targets.journal !== null) {
    const journal = await appendJournalOnce(paths.journal, targets.journal, operation.operationId);
    if (!journal.ok) return journal;
  }
  const afterJournal = await phase(onPhase, "after-journal");
  if (!afterJournal.ok) return afterJournal;
  try {
    await rm4(paths.pending, { force: true });
  } catch (error2) {
    return { ok: false, reason: `\uBCF4\uB958 \uC911\uC778 \uD559\uC2B5 \uC791\uC5C5\uC744 \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
  return { ok: true };
}
async function phase(onPhase, name) {
  if (typeof onPhase !== "function") return { ok: true };
  try {
    await onPhase(name);
    return { ok: true };
  } catch (error2) {
    return { ok: false, reason: `\uD559\uC2B5 \uC800\uC7A5 \uACBD\uACC4 ${name} \uC5D0\uC11C \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
}
function normalizeOperation(value) {
  const op = value !== null && typeof value === "object" ? value : null;
  const id = typeof op?.operationId === "string" && op.operationId !== "" ? op.operationId : null;
  const targets = op?.targets !== null && typeof op?.targets === "object" ? op.targets : null;
  const posteriors = targets?.posteriors;
  if (op?.version !== 1 || id === null || posteriors === void 0 || posteriors !== null && (typeof posteriors !== "object" || Array.isArray(posteriors))) {
    return { ok: false, reason: "version, operationId, targets.posteriors \uAC00 \uC788\uB294 \uC791\uC5C5\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4." };
  }
  let generations = null;
  if (targets.generations !== null && targets.generations !== void 0) {
    generations = normalizeGenerations(targets.generations);
  }
  let journal = null;
  if (targets.journal !== null && targets.journal !== void 0) {
    if (targets.journal === null || typeof targets.journal !== "object" || Array.isArray(targets.journal)) {
      return { ok: false, reason: "targets.journal \uC740 \uAC1D\uCCB4 \uB610\uB294 null \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4." };
    }
    if (typeof targets.journal.runId !== "string" || targets.journal.runId === "") {
      return { ok: false, reason: "targets.journal \uC5D0 runId \uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." };
    }
    journal = { ...targets.journal, operationId: id };
  }
  let quarantine = null;
  if (targets.quarantine !== null && targets.quarantine !== void 0) {
    const candidate = targets.quarantine;
    if (candidate === null || typeof candidate !== "object" || candidate.file !== "posteriors.corrupt.json" || typeof candidate.bytes !== "string") {
      return { ok: false, reason: "targets.quarantine \uC740 posteriors.corrupt.json \uBC14\uC774\uD2B8\uC5EC\uC57C \uD569\uB2C8\uB2E4." };
    }
    quarantine = { file: candidate.file, bytes: candidate.bytes };
  }
  return {
    ok: true,
    operation: { version: 1, operationId: id, targets: { posteriors, generations, journal, quarantine } }
  };
}
async function appendJournalOnce(file, entry, operationId) {
  let text = "";
  try {
    text = await readFile4(file, "utf8");
  } catch (error2) {
    if (error2?.code !== "ENOENT") return { ok: false, reason: `\uC2E4\uD589 \uC800\uB110\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
  for (const line2 of text.split("\n")) {
    try {
      if (JSON.parse(line2)?.operationId === operationId) return { ok: true };
    } catch {
    }
  }
  let line;
  try {
    line = JSON.stringify(entry);
  } catch (error2) {
    return { ok: false, reason: `\uC2E4\uD589 \uC800\uB110 \uC791\uC5C5\uC744 JSON \uC73C\uB85C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
  try {
    const handle = await open2(file, "a");
    try {
      await handle.writeFile(`${text !== "" && !text.endsWith("\n") ? "\n" : ""}${line}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => {
      });
    }
    return { ok: true };
  } catch (error2) {
    return { ok: false, reason: `\uC2E4\uD589 \uC800\uB110\uC5D0 \uC791\uC5C5\uC744 \uAE30\uB85D\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
}
async function writeAtomicJson(paths, target, name, value) {
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(value, null, 2)}
`, "utf8");
  } catch (error2) {
    return { ok: false, reason: `${name} \uC744(\uB97C) JSON \uC73C\uB85C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  }
  return writeAtomicBytes(paths, target, name, bytes);
}
async function writeAtomicBytes(paths, target, name, bytes) {
  const tmp = join6(paths.root, `${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open2(tmp, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync().catch(() => {
      });
    } finally {
      await handle.close().catch(() => {
      });
    }
    const moved = await renameWithRetry(tmp, target);
    return moved.ok ? { ok: true } : { ok: false, reason: `${name} \uC744(\uB97C) \uC81C\uC790\uB9AC\uB85C \uC62E\uAE30\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${moved.reason}` };
  } catch (error2) {
    return { ok: false, reason: `${name} \uC744(\uB97C) \uC4F0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe3(error2)}` };
  } finally {
    await rm4(tmp, { force: true }).catch(() => {
    });
  }
}
async function renameWithRetry(from, to) {
  let last = null;
  for (let attempt = 1; attempt <= RENAME_TRIES; attempt += 1) {
    try {
      await rename3(from, to);
      return { ok: true };
    } catch (error2) {
      last = error2;
      const retryable = error2?.code === "EPERM" || error2?.code === "EACCES" || error2?.code === "EBUSY";
      if (!retryable || attempt === RENAME_TRIES) break;
      await new Promise((resolve6) => setTimeout(resolve6, RENAME_WAIT_MS));
    }
  }
  return { ok: false, reason: describe3(last) };
}
function describe3(error2) {
  if (error2 === void 0) return "\uC0AC\uC720 \uC5C6\uC774 undefined \uAC00 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  if (error2 === null) return "\uC0AC\uC720 \uC5C6\uC774 null \uC774 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  try {
    return typeof error2?.message === "string" && error2.message !== "" ? error2.message : String(error2);
  } catch {
    return "\uC0AC\uC720\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  }
}

// src/learn/posteriors.mjs
var FILE = "posteriors.json";
var CORRUPT = "posteriors.corrupt.json";
var SNAPSHOT_FILE = "posteriors.prev.json";
var GENERATIONS_SNAPSHOT_FILE = "learning.generations.prev.json";
var RENAME_TRIES2 = 10;
var RENAME_WAIT_MS2 = 5;
var PRIOR = Object.freeze({ alpha: 1, beta: 1 });
function cellKeyOf(taskClass, axis) {
  return `${String(taskClass)}::${String(axis)}`;
}
var pathsFor2 = (stateRoot2) => typeof stateRoot2 === "string" && stateRoot2 !== "" && isAbsolute7(stateRoot2) ? {
  root: stateRoot2,
  file: join7(stateRoot2, FILE),
  corrupt: join7(stateRoot2, CORRUPT),
  snapshot: join7(stateRoot2, SNAPSHOT_FILE),
  generations: join7(stateRoot2, "learning.generations.json"),
  generationSnapshot: join7(stateRoot2, GENERATIONS_SNAPSHOT_FILE)
} : null;
var isPositiveFinite = (value) => Number.isFinite(value) && value > 0;
var clampArm = (value) => {
  const alpha = value?.alpha;
  const beta = value?.beta;
  return isPositiveFinite(alpha) && isPositiveFinite(beta) ? { alpha, beta } : { ...PRIOR };
};
function clampCells(raw) {
  const cells = [];
  for (const [cellKey, arms] of Object.entries(raw)) {
    if (arms === null || typeof arms !== "object" || Array.isArray(arms)) continue;
    cells.push([cellKey, Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, clampArm(value)]))]);
  }
  return Object.fromEntries(cells);
}
async function load(file) {
  let bytes;
  try {
    bytes = await readFile5(file);
  } catch (error2) {
    if (error2?.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", reason: `\uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe4(error2)}` };
  }
  const text = bytes.toString("utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error2) {
    return { state: "corrupt", bytes, reason: `\uC0AC\uD6C4\uBD84\uD3EC\uAC00 JSON \uC73C\uB85C \uC77D\uD788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4: ${describe4(error2)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "corrupt", bytes, reason: "\uC0AC\uD6C4\uBD84\uD3EC \uD30C\uC77C\uC774 \uC140 \uAC1D\uCCB4\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  }
  return { state: "ok", raw, bytes };
}
async function readPosteriors(stateRoot2) {
  const paths = pathsFor2(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  if (await hasPendingLearningOperation(stateRoot2)) {
    const recovered = await recoverLearning(stateRoot2);
    if (!recovered.ok) return recovered;
  }
  return readPosteriorsUnlocked(stateRoot2);
}
async function readPosteriorsUnlocked(stateRoot2) {
  const paths = pathsFor2(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const loaded = await load(paths.file);
  if (loaded.state === "missing") return { ok: true, cells: {} };
  if (loaded.state === "ok") return { ok: true, cells: clampCells(loaded.raw) };
  return { ok: false, reason: loaded.reason };
}
async function updatePosterior(stateRoot2, options) {
  return updatePosteriors(stateRoot2, [options]);
}
async function updatePosteriors(stateRoot2, updates) {
  const paths = pathsFor2(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  if (!Array.isArray(updates)) return { ok: false, reason: "updates \uAC00 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4." };
  const plan = [];
  for (const options of updates) {
    const { cellKey, arm, alphaDelta = 0, betaDelta = 0 } = options !== null && typeof options === "object" ? options : {};
    if (typeof cellKey !== "string" || cellKey === "") return { ok: false, reason: "cellKey \uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
    if (typeof arm !== "string" || arm === "") return { ok: false, reason: "arm \uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
    plan.push({ cellKey, arm, alphaDelta, betaDelta });
  }
  if (plan.length === 0) return { ok: true };
  const got = await withLearningLock(stateRoot2, async () => {
    const loaded = await load(paths.file);
    if (loaded.state === "unreadable") return { ok: false, reason: loaded.reason };
    const notes = [];
    let cells = {};
    if (loaded.state === "corrupt") {
      const moved = await renameWithRetry2(paths.file, paths.corrupt);
      if (!moved.ok) {
        return { ok: false, reason: `${loaded.reason} \uADF8\uB9AC\uACE0 ${CORRUPT} \uB85C \uCE58\uC6B0\uC9C0\uB3C4 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${moved.reason}` };
      }
      notes.push(`\uC190\uC0C1\uB41C \uC0AC\uD6C4\uBD84\uD3EC\uB97C ${CORRUPT} \uB85C \uCE58\uC6B0\uACE0 \uBC31\uC9C0\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uC791\uD569\uB2C8\uB2E4: ${loaded.reason}`);
    } else if (loaded.state === "ok") {
      cells = clampCells(loaded.raw);
    }
    const byCell = new Map(Object.entries(cells));
    for (const { cellKey, arm, alphaDelta, betaDelta } of plan) {
      const byArm = new Map(Object.entries(byCell.get(cellKey) ?? {}));
      const current = byArm.get(arm) ?? { ...PRIOR };
      const alpha = bump(current.alpha, alphaDelta, "alpha");
      const beta = bump(current.beta, betaDelta, "beta");
      if (alpha.note) notes.push(`${cellKey}: ${alpha.note}`);
      if (beta.note) notes.push(`${cellKey}: ${beta.note}`);
      byArm.set(arm, { alpha: alpha.value, beta: beta.value });
      byCell.set(cellKey, Object.fromEntries(byArm));
    }
    const written = await writeAtomic(paths, Object.fromEntries(byCell));
    return written.ok ? { ok: true, notes } : { ok: false, reason: written.reason };
  });
  return settle(got);
}
async function commitLearningMutation(stateRoot2, mutation, options) {
  const locked = await withLearningLock(stateRoot2, async () => commitLearningMutationUnlocked(stateRoot2, mutation, options));
  const settled = settle(locked);
  if (!settled.ok && locked.ok && typeof locked.value?.pending === "boolean") {
    return { ...settled, pending: locked.value.pending };
  }
  return settled;
}
async function commitLearningMutationUnlocked(stateRoot2, mutation, options) {
  const paths = pathsFor2(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const updates = Array.isArray(mutation?.updates) ? mutation.updates : [];
  const plan = normalizeUpdates(updates);
  if (!plan.ok) return plan;
  let target = { cells: null, notes: [], quarantine: null };
  if (plan.plan.length > 0) {
    target = await buildPosteriorTarget(paths, plan.plan);
    if (!target.ok) return { ...target, pending: false };
  }
  let journal = null;
  if (mutation?.journal !== null && mutation?.journal !== void 0) {
    const generations = await readGenerationsUnlocked(stateRoot2);
    if (!generations.ok) return { ...generations, pending: false };
    const prepared = prepareJournalTarget(mutation.journal, generations.generations);
    if (!prepared.ok) return { ...prepared, pending: false };
    journal = prepared.entry;
  }
  const operation = {
    version: 1,
    operationId: makeOperationId(),
    targets: { posteriors: target.cells, generations: null, journal, quarantine: target.quarantine }
  };
  const committed = await commitLearningOperationUnlocked(stateRoot2, operation, options);
  if (!committed.ok) {
    return { ...committed, pending: await hasPendingLearningOperation(stateRoot2) };
  }
  return target.notes.length > 0 ? { ok: true, notes: target.notes } : { ok: true, notes: [] };
}
function normalizeUpdates(updates) {
  if (!Array.isArray(updates)) return { ok: false, reason: "updates \uAC00 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4." };
  const plan = [];
  for (const options of updates) {
    const { cellKey, arm, alphaDelta = 0, betaDelta = 0 } = options !== null && typeof options === "object" ? options : {};
    if (typeof cellKey !== "string" || cellKey === "") return { ok: false, reason: "cellKey \uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
    if (typeof arm !== "string" || arm === "") return { ok: false, reason: "arm \uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
    plan.push({ cellKey, arm, alphaDelta, betaDelta });
  }
  return { ok: true, plan };
}
async function buildPosteriorTarget(paths, plan) {
  const loaded = await load(paths.file);
  if (loaded.state === "unreadable") return { ok: false, reason: loaded.reason };
  const notes = [];
  let quarantine = null;
  let cells = {};
  if (loaded.state === "corrupt") {
    quarantine = { file: CORRUPT, bytes: loaded.bytes.toString("base64") };
    notes.push(`\uC190\uC0C1\uB41C \uC0AC\uD6C4\uBD84\uD3EC\uB97C ${CORRUPT} \uB85C \uBCF4\uC874\uD558\uACE0 \uBC31\uC9C0\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uC791\uD569\uB2C8\uB2E4: ${loaded.reason}`);
  } else if (loaded.state === "ok") {
    cells = clampCells(loaded.raw);
  }
  const byCell = new Map(Object.entries(cells));
  for (const { cellKey, arm, alphaDelta, betaDelta } of plan) {
    const byArm = new Map(Object.entries(byCell.get(cellKey) ?? {}));
    const current = byArm.get(arm) ?? { ...PRIOR };
    const alpha = bump(current.alpha, alphaDelta, "alpha");
    const beta = bump(current.beta, betaDelta, "beta");
    if (alpha.note) notes.push(`${cellKey}: ${alpha.note}`);
    if (beta.note) notes.push(`${cellKey}: ${beta.note}`);
    byArm.set(arm, { alpha: alpha.value, beta: beta.value });
    byCell.set(cellKey, Object.fromEntries(byArm));
  }
  return { ok: true, cells: Object.fromEntries(byCell), notes, quarantine };
}
function prepareJournalTarget(entry, generations) {
  try {
    if (entry === null || typeof entry !== "object" || typeof entry.runId !== "string" || entry.runId === "") {
      return { ok: false, reason: "runId \uAC00 \uC788\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4." };
    }
    const now = Date.now();
    const taskClass = typeof entry.taskClass === "string" ? entry.taskClass : null;
    const axesOf = (value) => Array.isArray(value) ? value.filter((axis) => typeof axis === "string" && axis !== "") : [];
    const mapFor = (axes) => Object.fromEntries(axes.map((axis) => [axis, taskClass === null ? 0 : generationOf(generations, cellKeyOf(taskClass, axis))]));
    const appliedAxes = axesOf(entry.appliedAxes);
    const rewardableAxes = axesOf(entry.rewardableAxes);
    return {
      ok: true,
      entry: {
        ...entry,
        at: Number.isFinite(entry.at) ? entry.at : now,
        updatedAt: now,
        appliedGenerations: mapFor(appliedAxes),
        rewardableGenerations: mapFor(rewardableAxes)
      }
    };
  } catch (error2) {
    return { ok: false, reason: `\uC2E4\uD589 \uC800\uB110 \uC791\uC5C5\uC744 \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe4(error2)}` };
  }
}
async function resetPosteriors(stateRoot2, options) {
  const paths = pathsFor2(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  const { cellKey = null, cellKeys, taskClass, onPhase } = options !== null && typeof options === "object" ? options : {};
  if (cellKey !== null && cellKey !== void 0) {
    if (typeof cellKey !== "string") return { ok: false, reason: "cellKey \uAC00 \uBB38\uC790\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4." };
    if (cellKey === "") return { ok: false, reason: "cellKey \uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." };
  }
  if (cellKeys !== void 0) {
    if (cellKey !== null && cellKey !== void 0) return { ok: false, reason: "cellKey \uC640 cellKeys \uB97C \uD568\uAED8 \uC904 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." };
    if (!Array.isArray(cellKeys)) return { ok: false, reason: "cellKeys \uAC00 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4." };
    for (const key of cellKeys) {
      if (typeof key !== "string" || key === "") return { ok: false, reason: "cellKeys \uC5D0 \uBE48 \uBB38\uC790\uC5F4 \uC544\uB2CC \uBB38\uC790\uC5F4\uB9CC \uB123\uC73C\uC138\uC694." };
    }
  }
  if (taskClass !== void 0) {
    if (typeof taskClass !== "string" || taskClass === "") return { ok: false, reason: "taskClass \uAC00 \uBE48 \uBB38\uC790\uC5F4 \uC544\uB2CC \uBB38\uC790\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4." };
    if (cellKey !== null && cellKey !== void 0 || cellKeys !== void 0) {
      return { ok: false, reason: "taskClass \uB294 cellKey \uB610\uB294 cellKeys \uC640 \uD568\uAED8 \uC904 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." };
    }
  }
  let only = cellKeys === void 0 ? cellKey ?? null : new Set(cellKeys);
  const got = await withLearningLock(stateRoot2, async () => {
    const loaded = await load(paths.file);
    if (loaded.state === "unreadable") return { ok: false, reason: loaded.reason };
    if (taskClass !== void 0) {
      if (loaded.state === "missing") return { ok: true, cleared: 0, asked: 0, cellKeys: [], notes: [] };
      if (loaded.state !== "ok") return { ok: false, reason: "\uC190\uC0C1\uB41C \uC0AC\uD6C4\uBD84\uD3EC\uC5D0\uC11C\uB294 taskClass \uBC94\uC704\uB97C \uC815\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC804\uCCB4 reset\uC744 \uC0AC\uC6A9\uD558\uC138\uC694." };
      only = new Set(
        Object.keys(loaded.raw).filter((key) => {
          const marker = key.indexOf("::");
          return marker >= 0 && key.slice(0, marker) === taskClass;
        })
      );
    }
    const asked = taskClass === void 0 ? void 0 : only instanceof Set ? only.size : 0;
    const selectedKeys = taskClass === void 0 || !(only instanceof Set) ? null : [...only];
    if (loaded.state === "missing") {
      return { ok: true, cleared: 0, ...asked === void 0 ? {} : { asked, cellKeys: selectedKeys }, notes: [] };
    }
    if (only instanceof Set && only.size === 0) return { ok: true, cleared: 0, ...asked === void 0 ? {} : { asked, cellKeys: selectedKeys }, notes: [] };
    if (loaded.state === "corrupt") {
      const snapshotted2 = await writeSnapshot(paths, loaded.bytes);
      if (!snapshotted2.ok) return { ok: false, reason: `\uC2A4\uB0C5\uC0F7\uC744 \uC4F0\uC9C0 \uBABB\uD574 reset \uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${snapshotted2.reason}` };
      const generationsSnapshotted2 = await writeGenerationSnapshot(paths);
      if (!generationsSnapshotted2.ok) return { ok: false, reason: `\uC138\uB300 \uC2A4\uB0C5\uC0F7\uC744 \uC4F0\uC9C0 \uBABB\uD574 reset \uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${generationsSnapshotted2.reason}` };
      const advanced2 = await resetGenerationTarget(stateRoot2, {}, null, onPhase);
      if (!advanced2.ok) return { ...advanced2, ...asked === void 0 ? {} : { asked, cellKeys: selectedKeys } };
      return { ok: true, cleared: 0, discarded: true, snapshotted: true, notes: [`\uC77D\uC744 \uC218 \uC5C6\uB294 \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uBC84\uB838\uC2B5\uB2C8\uB2E4: ${loaded.reason}`] };
    }
    const byCell = new Map(Object.entries(loaded.raw));
    if (only === null) byCell.clear();
    else if (only instanceof Set) {
      for (const key of only) byCell.delete(key);
    } else byCell.delete(only);
    const cleared = Object.keys(loaded.raw).length - byCell.size;
    if (cleared === 0) return { ok: true, cleared: 0, ...asked === void 0 ? {} : { asked, cellKeys: selectedKeys }, notes: [] };
    const snapshotted = await writeSnapshot(paths, loaded.bytes);
    if (!snapshotted.ok) return { ok: false, reason: `\uC2A4\uB0C5\uC0F7\uC744 \uC4F0\uC9C0 \uBABB\uD574 reset \uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${snapshotted.reason}` };
    const generationsSnapshotted = await writeGenerationSnapshot(paths);
    if (!generationsSnapshotted.ok) return { ok: false, reason: `\uC138\uB300 \uC2A4\uB0C5\uC0F7\uC744 \uC4F0\uC9C0 \uBABB\uD574 reset \uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${generationsSnapshotted.reason}` };
    const removed = Object.keys(loaded.raw).filter((key) => !byCell.has(key));
    const advanced = await resetGenerationTarget(stateRoot2, Object.fromEntries(byCell), only === null ? null : removed, onPhase);
    return advanced.ok ? { ok: true, cleared, snapshotted: true, ...asked === void 0 ? {} : { asked, cellKeys: removed }, notes: [] } : { ...advanced, ...asked === void 0 ? {} : { asked, cellKeys: selectedKeys } };
  });
  const settled = settle(got);
  const \uBC84\uB838\uB098 = got.value?.discarded === true ? { discarded: true } : {};
  if (!settled.ok) {
    return got.ok && Number.isInteger(got.value?.asked) ? { ...settled, asked: got.value.asked, cellKeys: got.value.cellKeys } : settled;
  }
  return {
    ...settled,
    ...\uBC84\uB838\uB098,
    cleared: got.value.cleared,
    ...Number.isInteger(got.value?.asked) ? { asked: got.value.asked, cellKeys: got.value.cellKeys } : {}
  };
}
async function resetGenerationTarget(stateRoot2, posteriors, scopedKeys, onPhase) {
  const existing = await readGenerationsUnlocked(stateRoot2);
  if (!existing.ok) return existing;
  const next = {
    global: existing.generations.global,
    cells: { ...existing.generations.cells }
  };
  if (scopedKeys === null) {
    next.global = Math.max(existing.generations.global, ...Object.values(existing.generations.cells), 0) + 1;
    next.cells = {};
  } else {
    for (const key of scopedKeys) next.cells[key] = generationOf(existing.generations, key) + 1;
  }
  return commitLearningOperationUnlocked(stateRoot2, {
    version: 1,
    operationId: makeOperationId(),
    targets: { posteriors, generations: next, journal: null }
  }, { onPhase });
}
function settle(got) {
  const leftover = got.released === false ? `\uC0AC\uD6C4\uBD84\uD3EC \uC7A0\uAE08\uC774 \uB0A8\uC558\uC2B5\uB2C8\uB2E4: ${got.releaseReason}` : null;
  if (!got.ok) return { ok: false, reason: [got.reason, leftover].filter(Boolean).join(" / ") };
  const inner = got.value;
  if (!inner.ok) return { ok: false, reason: [inner.reason, leftover].filter(Boolean).join(" / ") };
  const notices = [...inner.notes, leftover].filter(Boolean);
  return notices.length > 0 ? { ok: true, notice: notices.join(" / ") } : { ok: true };
}
function bump(base, delta, name) {
  const step = Number.isFinite(delta) ? delta : 0;
  const next = base + step;
  if (!Number.isFinite(next)) {
    return { value: base, note: `${name} \uAC00 \uC720\uD55C\uD55C \uBC94\uC704\uB97C \uB118\uC5B4 \uAC31\uC2E0\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.` };
  }
  const floor = Math.min(base, PRIOR[name]);
  if (next < floor) {
    return { value: floor, note: `${name} \uAC00 \uD558\uD55C ${floor} \uBC11\uC73C\uB85C \uB0B4\uB824\uAC00 \uB9C9\uC558\uC2B5\uB2C8\uB2E4(${base} + ${step} = ${next}).` };
  }
  return { value: next, note: null };
}
async function writeAtomic(paths, cells) {
  return writeAtomicBytes2(paths, paths.file, FILE, Buffer.from(`${JSON.stringify(cells, null, 2)}
`, "utf8"), "\uC0AC\uD6C4\uBD84\uD3EC");
}
async function writeSnapshot(paths, bytes) {
  return writeAtomicBytes2(paths, paths.snapshot, SNAPSHOT_FILE, bytes, "\uC0AC\uD6C4\uBD84\uD3EC \uC2A4\uB0C5\uC0F7");
}
async function writeGenerationSnapshot(paths) {
  let bytes;
  try {
    bytes = await readFile5(paths.generations);
  } catch (error2) {
    if (error2?.code !== "ENOENT") return { ok: false, reason: describe4(error2) };
    bytes = Buffer.from('{\n  "global": 0,\n  "cells": {}\n}\n', "utf8");
  }
  return writeAtomicBytes2(paths, paths.generationSnapshot, GENERATIONS_SNAPSHOT_FILE, bytes, "\uD559\uC2B5 \uC138\uB300 \uC2A4\uB0C5\uC0F7");
}
async function writeAtomicBytes2(paths, target, name, bytes, label) {
  const tmp = join7(paths.root, `${name}.${process.pid}.${randomUUID2()}.tmp`);
  try {
    const handle = await open3(tmp, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync().catch(() => {
      });
    } finally {
      await handle.close().catch(() => {
      });
    }
    const moved = await renameWithRetry2(tmp, target);
    return moved.ok ? { ok: true } : { ok: false, reason: `${label}\uC744(\uB97C) \uC81C\uC790\uB9AC\uB85C \uC62E\uAE30\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${moved.reason}` };
  } catch (error2) {
    return { ok: false, reason: `${label}\uC744(\uB97C) \uC4F0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe4(error2)}` };
  } finally {
    await rm5(tmp, { force: true }).catch(() => {
    });
  }
}
async function renameWithRetry2(from, to) {
  let last = null;
  for (let attempt = 1; attempt <= RENAME_TRIES2; attempt += 1) {
    try {
      await rename4(from, to);
      return { ok: true };
    } catch (error2) {
      last = error2;
      const retryable = error2?.code === "EPERM" || error2?.code === "EACCES" || error2?.code === "EBUSY";
      if (!retryable || attempt === RENAME_TRIES2) break;
      await new Promise((r) => setTimeout(r, RENAME_WAIT_MS2));
    }
  }
  return { ok: false, reason: describe4(last) };
}
function describe4(error2) {
  if (error2 === void 0) return "\uC0AC\uC720 \uC5C6\uC774 undefined \uAC00 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  if (error2 === null) return "\uC0AC\uC720 \uC5C6\uC774 null \uC774 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  try {
    const message = error2?.message;
    if (typeof message === "string" && message !== "") return message;
    return String(error2);
  } catch {
    return "\uC0AC\uC720\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  }
}

// src/learn/bandit.mjs
var AXES = Object.freeze({
  mix: Object.freeze({ arms: Object.freeze(["mix", "single"]), default: "mix" }),
  placement: Object.freeze({ arms: Object.freeze(["claude>codex", "codex>claude"]), default: "claude>codex" }),
  rewrite: Object.freeze({ arms: Object.freeze(["deep", "wide"]), default: "deep" }),
  tier: Object.freeze({ arms: Object.freeze(["strong", "fast"]), default: "strong" })
});
var OBSERVATION_THRESHOLD = 5;
var FALLBACK_CLASS = "analysis";
var ACCEPT_TRIES = 200;
function shapesOf(cell, arm) {
  const value = cell !== null && typeof cell === "object" && Object.hasOwn(cell, arm) ? cell[arm] : null;
  const alpha = value?.alpha;
  const beta = value?.beta;
  const good = Number.isFinite(alpha) && alpha > 0 && Number.isFinite(beta) && beta > 0;
  return good ? { alpha, beta } : { ...PRIOR };
}
function observationsOf(arms, knownArms) {
  if (!Array.isArray(knownArms)) return 0;
  let total = 0;
  for (const name of knownArms) {
    const { alpha, beta } = shapesOf(arms, name);
    total += Math.max(0, alpha + beta - PRIOR.alpha - PRIOR.beta);
  }
  return total;
}
function unit(random) {
  const value = random();
  if (value === 0) return Number.EPSILON;
  if (!(value > 0 && value < 1)) return 0.5;
  return value;
}
function sampleGamma(shape, random) {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(unit(random), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < ACCEPT_TRIES; attempt += 1) {
    const u1 = unit(random);
    const u2 = unit(random);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const v = (1 + c * z) ** 3;
    if (v <= 0) continue;
    const u = unit(random);
    if (Math.log(u) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}
function sampleBeta(alpha, beta, random) {
  const draw = typeof random === "function" ? random : Math.random;
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : PRIOR.alpha;
  const b = Number.isFinite(beta) && beta > 0 ? beta : PRIOR.beta;
  const x = sampleGamma(a, draw);
  const y = sampleGamma(b, draw);
  return x + y > 0 ? x / (x + y) : 0.5;
}
var COUNT_CAP = 1e6;
var count = (value) => {
  if (!(value <= COUNT_CAP)) return "1,000,000+";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};
var armAllowed = (axis, arm, allowSingle) => axis !== "mix" || arm !== "single" || allowSingle;
var EVIDENCE_HEADER = "\u2501\u2501\u2501 \uC774 \uC800\uC7A5\uC18C\uC5D0\uC11C \uAD00\uCC30\uB41C \uC0AC\uC2E4 \u2501\u2501\u2501";
function readOption(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}
function decide(spec) {
  const options = spec !== null && typeof spec === "object" ? spec : {};
  const cells = readOption(() => options.cells !== null && typeof options.cells === "object" ? options.cells : {}, {});
  const taskClass = readOption(
    () => typeof options.taskClass === "string" && options.taskClass !== "" ? options.taskClass : FALLBACK_CLASS,
    FALLBACK_CLASS
  );
  const allowSingle = readOption(() => options.allowed?.single === true, false);
  const random = readOption(() => typeof options.random === "function" ? options.random : Math.random, Math.random);
  const decisions = {};
  const sources = {};
  const lines = [];
  for (const [axis, axisSpec] of Object.entries(AXES)) {
    try {
      const key = cellKeyOf(taskClass, axis);
      const raw = Object.hasOwn(cells, key) ? cells[key] : null;
      const cell = raw !== null && typeof raw === "object" ? raw : {};
      const arms = axisSpec.arms.filter((arm) => armAllowed(axis, arm, allowSingle));
      if (arms.length < 2) {
        decisions[axis] = axisSpec.default;
        sources[axis] = "default";
        continue;
      }
      const seen = observationsOf(cell, axisSpec.arms);
      if (seen < OBSERVATION_THRESHOLD) {
        decisions[axis] = axisSpec.default;
        sources[axis] = "default";
        continue;
      }
      let best = arms[0];
      let bestDraw = -1;
      for (const arm of arms) {
        const { alpha, beta } = shapesOf(cell, arm);
        const draw = sampleBeta(alpha, beta, random);
        if (draw > bestDraw) {
          bestDraw = draw;
          best = arm;
        }
      }
      const picked = shapesOf(cell, best);
      const armSeen = Math.max(0, picked.alpha + picked.beta - PRIOR.alpha - PRIOR.beta);
      const wins = Math.max(0, picked.alpha - PRIOR.alpha);
      const line = armSeen === 0 ? `\xB7 ${axis}: ${best} \u2014 \uC544\uC9C1 \uAD00\uCE21\uC774 \uC5C6\uC5B4 \uD0D0\uC0C9\uC73C\uB85C \uACE8\uB790\uC2B5\uB2C8\uB2E4 (\uC774 \uCD95 \uC804\uCCB4 ${count(seen)}\uAC74)` : `\xB7 ${axis}: ${best} \u2014 \uAD00\uCE21 ${count(armSeen)}\uAC74 \uC911 \uC131\uACF5 ${count(wins)}\uAC74 (\uC774 \uCD95 \uC804\uCCB4 ${count(seen)}\uAC74)`;
      decisions[axis] = best;
      sources[axis] = "bandit";
      lines.push(line);
    } catch {
      decisions[axis] = axisSpec.default;
      sources[axis] = "default";
    }
  }
  const evidence = lines.length > 0 ? `${EVIDENCE_HEADER}
${lines.join("\n")}` : `${EVIDENCE_HEADER}
\xB7 \uC544\uC9C1 \uD310\uB2E8\uD560 \uB9CC\uD07C\uC758 \uAD00\uCE21\uC774 \uC5C6\uC5B4(\uCD95\uB9C8\uB2E4 ${OBSERVATION_THRESHOLD}\uAC74 \uD544\uC694) \uAE30\uBCF8\uAC12\uC73C\uB85C \uC9C4\uD589\uD569\uB2C8\uB2E4.`;
  return { decisions, sources, evidence };
}
function gradeToDeltas(grade) {
  if (grade === "success") return { alphaDelta: 1, betaDelta: 0 };
  if (grade === "failure") return { alphaDelta: 0, betaDelta: 1 };
  return null;
}

// src/learn/classify.mjs
var TASK_CLASSES = Object.freeze(["code:test-bearing", "code:no-tests", "prose", "analysis"]);
var PROSE = /(문서|readme|요약|번역|정리해|써줘|작성해|설명문|설명서|가이드|매뉴얼|튜토리얼|위키|레퍼런스|노트|라이선스|changelog|license|contributing|guide|tutorial|wiki|document|docs)/i;
var CODE = /((고쳐|수정해|추가해|삭제해|옮겨|바꿔|최적화해|세팅해|만들어|달아)(?!야)|버그|구현|리팩터|테스트를? 만들|fix|bug|implement|refactor)/i;
var CLASSIFY_PATTERNS = Object.freeze({ PROSE, CODE });
function classifyTask(spec) {
  const options = spec !== null && typeof spec === "object" ? spec : {};
  const task = typeof options.task === "string" ? options.task : "";
  const hasTests = typeof options.testSource === "string" && options.testSource !== "";
  if (PROSE.test(task)) return "prose";
  if (CODE.test(task)) return hasTests ? "code:test-bearing" : "code:no-tests";
  return "analysis";
}

// src/learn/journal.mjs
import { open as open4, readFile as readFile6, stat as stat4 } from "node:fs/promises";
import { isAbsolute as isAbsolute8, join as join8 } from "node:path";
var FILE2 = "journal.jsonl";
var DEFAULT_LIMIT = 500;
var RUN_ENTRY_KEYS = Object.freeze([
  "runId",
  "at",
  "updatedAt",
  "taskClass",
  "decisions",
  "outcome",
  "appliedGrade",
  "appliedAxes",
  "rewardableAxes",
  "appliedGenerations",
  "rewardableGenerations",
  "operationId",
  "rewardApplied",
  "note"
]);
var pathsFor3 = (stateRoot2) => typeof stateRoot2 === "string" && stateRoot2 !== "" && isAbsolute8(stateRoot2) ? { file: join8(stateRoot2, FILE2) } : null;
var JOURNAL_LARGE_BYTES = 10 * 1024 * 1024;
async function journalBytes(stateRoot2) {
  const paths = pathsFor3(stateRoot2);
  if (paths === null) return null;
  try {
    return (await stat4(paths.file)).size;
  } catch {
    return null;
  }
}
async function appendRun(stateRoot2, entry) {
  const paths = pathsFor3(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  let line;
  try {
    if (entry === null || typeof entry !== "object" || typeof entry.runId !== "string" || entry.runId === "") {
      return { ok: false, reason: "runId \uAC00 \uC788\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4." };
    }
    const now = Date.now();
    const at = Number.isFinite(entry.at) ? entry.at : now;
    line = `${JSON.stringify({ ...entry, at, updatedAt: now })}
`;
  } catch (error2) {
    return { ok: false, reason: `\uAE30\uB85D\uC744 JSON \uC73C\uB85C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${describe5(error2)}` };
  }
  const got = await withLearningLock(stateRoot2, async () => {
    const prefix = await endsWithNewline(paths.file) ? "" : "\n";
    const handle = await open4(paths.file, "a");
    try {
      await handle.writeFile(`${prefix}${line}`, "utf8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => {
      });
    }
  });
  if (!got.ok) return { ok: false, reason: got.reason };
  return got.released === false ? { ok: true, notice: `\uC800\uB110 \uC7A0\uAE08\uC774 \uB0A8\uC558\uC2B5\uB2C8\uB2E4: ${got.releaseReason}` } : { ok: true };
}
async function readRunsUnlocked(stateRoot2, options) {
  const paths = pathsFor3(stateRoot2);
  if (paths === null) return { ok: false, reason: "\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4." };
  return readRunsAtPaths(paths, options);
}
async function readRunsAtPaths(paths, options) {
  const { limit = DEFAULT_LIMIT } = options && typeof options === "object" ? options : {};
  const take = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_LIMIT;
  let text;
  try {
    text = await readFile6(paths.file, "utf8");
  } catch (error2) {
    if (error2?.code === "ENOENT") return { ok: true, runs: [] };
    return { ok: false, reason: `\uC800\uB110\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${String(error2?.message ?? error2)}` };
  }
  const found = collect(text);
  found.sort(byRecency);
  return { ok: true, runs: found.slice(0, take).reverse().map((r) => r.entry) };
}
async function findRunUnlocked(stateRoot2, runId) {
  if (typeof runId !== "string" || runId === "") return null;
  const got = await readRunsUnlocked(stateRoot2, { limit: Number.MAX_SAFE_INTEGER });
  if (!got.ok) return null;
  return got.runs.find((r) => r.runId === runId) ?? null;
}
var OLDEST = Number.MIN_SAFE_INTEGER;
function collect(text) {
  const byId = /* @__PURE__ */ new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const runId = parsed?.runId;
    if (typeof runId !== "string" || runId === "") continue;
    byId.set(runId, { entry: parsed, at: Number.isFinite(parsed.at) ? parsed.at : OLDEST, pos: i });
  }
  return [...byId.values()];
}
var byRecency = (a, b) => a.at === b.at ? b.pos - a.pos : b.at - a.at;
async function endsWithNewline(file) {
  let handle = null;
  try {
    handle = await open4(file, "r");
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, size - 1);
    return bytesRead === 1 && buf[0] === 10;
  } catch (error2) {
    return error2?.code === "ENOENT";
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
function describe5(error2) {
  if (error2 === void 0) return "\uC0AC\uC720 \uC5C6\uC774 undefined \uAC00 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  if (error2 === null) return "\uC0AC\uC720 \uC5C6\uC774 null \uC774 \uB358\uC838\uC84C\uC2B5\uB2C8\uB2E4.";
  try {
    const message = error2?.message;
    if (typeof message === "string" && message !== "") return message;
    return String(error2);
  } catch {
    return "\uC0AC\uC720\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  }
}

// src/patch-scope.mjs
import { dirname as dirname2, isAbsolute as isAbsolute9, join as join9, relative, resolve as resolve2 } from "node:path";
var GENERIC_RECOVERY3 = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
function blocked2(error2, recovery) {
  return { blocked: true, error: error2, recovery: recovery && recovery !== "" ? recovery : GENERIC_RECOVERY3 };
}
var GIT_TIMEOUT_MS = 12e4;
var MAX_REASONS = 100;
var RECOVERY_SAMPLE = 5;
var SENSITIVE_DIR_SEGMENTS = /* @__PURE__ */ new Set([
  ".github",
  ".gitlab",
  ".circleci",
  ".husky",
  ".devcontainer",
  ".vscode",
  ".git",
  ".claude",
  ".gitea",
  ".forgejo"
]);
var SENSITIVE_FILE_NAMES = /* @__PURE__ */ new Set([
  // CI 정의
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "jenkinsfile",
  ".travis.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "bitbucket-pipelines.yml",
  // 패키지 매니저 — install 시점에 스크립트·레지스트리·자격증명이 걸린다
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  ".pypirc",
  "nuget.config",
  // lockfile — 설계 §5.8:387 이 차단 목록에 명시했는데 코드에서 빠져 있었다(실측:
  // `package-lock.json`·`yarn.lock`·`pnpm-lock.yaml`·`Cargo.lock` 넷 전부
  // flagged=false). 잠긴 URL·integrity 를 바꾸면 다음 install 이 공격자 tarball 을
  // 가져오고 그 postinstall 이 돈다.
  //
  // 오탐 비용이 낮은 근거(둘 다 실측 기반): 워커에게는 Bash 가 없고(§12.-1),
  // `src/test-runner.mjs` 는 **의존성을 설치하지도 링크하지도 않는다.** 즉 아래
  // 이름들을 다시 쓸 수 있는 프로세스가 이 파이프라인에 없다 — 바뀌었다면 델리게이트가
  // 손으로 고친 것이다.
  //
  // ⚠ `packages.lock.json`(NuGet)은 **일부러 뺐다.** 러너가 지원하는 `dotnet test` 가
  //   암묵적 restore 를 돌리고, `RestorePackagesWithLockFile` 을 켠 프로젝트에서는 그
  //   restore 가 그 파일을 다시 쓴다 — 우리가 한 일로 사용자의 실행을 disputed 로
  //   강등하게 된다. 대신 아래 [[잔여 위험]] 에 적는다.
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  // 셸 rc — 다음 대화형 셸에서 발화한다
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".kshrc",
  ".cshrc",
  ".envrc",
  // direnv — 디렉터리에 들어가는 것만으로 실행된다
  // 빌드 시스템이 자동으로 읽는 설정
  "directory.build.props",
  "directory.build.targets",
  "directory.build.rsp",
  "directory.packages.props",
  // 이 서버의 호출자
  ".mcp.json",
  // Dev Containers 의 공식 설정 위치는 셋이다:
  //   .devcontainer/devcontainer.json · .devcontainer/<folder>/devcontainer.json · 루트 .devcontainer.json
  // 앞의 둘은 위 SENSITIVE_DIR_SEGMENTS 의 `.devcontainer` 가 잡지만, 루트 형태는 세그먼트가
  // `.devcontainer.json` 하나뿐이라 안 걸렸다. 실측: 델리게이트의 Write 한 번으로
  // `{"initializeCommand": …}` 를 심었더니 flagged=false 로 통과하고 git apply 가 exit 0 으로
  // 사용자 저장소 루트에 떨어뜨렸다. `initializeCommand` 는 컨테이너가 아니라 호스트에서 돈다.
  ".devcontainer.json"
]);
var SHORT_NAME_BASE = /^[^.]+~[0-9]{1,2}$/;
function segmentsOf(path) {
  return path.split("/").filter((segment) => segment !== "");
}
function looksLikeShortName(segment) {
  const dot = segment.lastIndexOf(".");
  const base = dot > 0 ? segment.slice(0, dot) : segment;
  const extension = dot > 0 ? segment.slice(dot + 1) : "";
  if (base.length > 8 || extension.length > 3) return false;
  return SHORT_NAME_BASE.test(base);
}
function inspectPath(path) {
  const found = [];
  const segments = segmentsOf(path);
  const last = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : "";
  for (const segment of segments) {
    const folded = segment.toLowerCase();
    if (SENSITIVE_DIR_SEGMENTS.has(folded)) {
      found.push({ path, rule: "sensitive-path", detail: `\uACBD\uB85C \uC138\uADF8\uBA3C\uD2B8 '${segment}' \uB294 \uC801\uC6A9 \uB4A4\uC5D0 \uBA85\uB839\uC774 \uB3C4\uB294 \uC790\uB9AC\uC785\uB2C8\uB2E4.` });
    }
    if (looksLikeShortName(segment)) {
      found.push({
        path,
        rule: "short-name",
        detail: `\uC138\uADF8\uBA3C\uD2B8 '${segment}' \uAC00 Windows 8.3 \uB2E8\uCD95 \uC774\uB984 \uBAA8\uC591\uC785\uB2C8\uB2E4 \u2014 \uC801\uC6A9\uD558\uB294 \uC800\uC7A5\uC18C\uC5D0\uC11C \uB2E4\uB978 \uAE34 \uC774\uB984\uC73C\uB85C \uD480\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`
      });
    }
  }
  if (SENSITIVE_FILE_NAMES.has(last)) {
    found.push({ path, rule: "sensitive-path", detail: `'${segments[segments.length - 1]}' \uB294 \uB3C4\uAD6C\uAC00 \uC790\uB3D9\uC73C\uB85C \uC77D\uB294 \uC124\uC815 \uD30C\uC77C\uC785\uB2C8\uB2E4.` });
  }
  return found;
}
async function listIndexEntries({ run: run3, worktree }) {
  const listed = await run3({ args: ["ls-files", "-s", "-z"], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  if (!listed.ok || typeof listed.stdout !== "string") return { failure: listed };
  const entries = [];
  for (const record2 of listed.stdout.split("\0")) {
    const tab = record2.indexOf("	");
    if (tab === -1) continue;
    const [mode, sha] = record2.slice(0, tab).split(" ");
    const path = record2.slice(tab + 1);
    if (typeof mode === "string" && typeof sha === "string" && sha !== "" && path !== "") {
      entries.push({ path, sha, mode });
    }
  }
  return { entries };
}
async function readBlob({ run: run3, worktree, sha }) {
  const blob = await run3({ args: ["cat-file", "blob", sha], cwd: worktree, timeoutMs: GIT_TIMEOUT_MS });
  return blob.ok && typeof blob.stdout === "string" ? blob.stdout : null;
}
function readScripts(text) {
  if (typeof text !== "string") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (!parsed || typeof parsed !== "object") return void 0;
  const scripts = parsed.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
}
function changedScriptKeys(before, after) {
  const changed = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}
async function inspectPackageScripts({ run: run3, worktree, baseline, files, entries }) {
  const wanted = new Set(files.filter((path) => segmentsOf(path).at(-1)?.toLowerCase() === "package.json"));
  if (wanted.size === 0) return [];
  const commitBaseline = typeof baseline === "string" && baseline !== "";
  const sourceBaseline = baseline !== null && typeof baseline === "object" && !Array.isArray(baseline);
  if (!commitBaseline && !sourceBaseline) {
    return [...wanted].map((path) => ({
      path,
      rule: "package-baseline-missing",
      detail: "\uBCA0\uC774\uC2A4\uB77C\uC778\uC774 \uC5C6\uC5B4 package.json \uC758 scripts \uBCC0\uACBD \uC5EC\uBD80\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
    }));
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const reasons = [];
  for (const path of wanted) {
    const entry = byPath.get(path);
    const current = entry ? readScripts(await readBlob({ run: run3, worktree, sha: entry.sha })) : {};
    if (current === void 0) {
      reasons.push({
        path,
        rule: "package-unreadable",
        detail: "JSON \uC73C\uB85C \uC77D\uC9C0 \uBABB\uD574 scripts \uBE14\uB85D\uC774 \uADF8\uB300\uB85C\uC778\uC9C0 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
      });
      continue;
    }
    let beforeText = null;
    if (commitBaseline) {
      const before = await run3({
        args: ["cat-file", "blob", `${baseline}:${path}`],
        cwd: worktree,
        timeoutMs: GIT_TIMEOUT_MS
      });
      beforeText = before.ok && typeof before.stdout === "string" ? before.stdout : null;
    } else if (Object.hasOwn(baseline, path)) {
      beforeText = baseline[path];
    }
    const baselineScripts = beforeText === null ? {} : readScripts(beforeText);
    if (baselineScripts === void 0) {
      reasons.push({
        path,
        rule: "package-unreadable",
        detail: "\uBCA0\uC774\uC2A4\uB77C\uC778\uC758 package.json \uC744 JSON \uC73C\uB85C \uC77D\uC9C0 \uBABB\uD574 scripts \uBE14\uB85D\uC744 \uB300\uC870\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
      });
      continue;
    }
    const changed = changedScriptKeys(baselineScripts, current);
    if (changed.length > 0) {
      reasons.push({
        path,
        rule: "package-scripts",
        detail: `scripts \uBE14\uB85D\uC774 \uB2EC\uB77C\uC84C\uC2B5\uB2C8\uB2E4: ${changed.join(", ")}. \uC774 \uC790\uB9AC\uC758 \uBA85\uB839\uC740 \uC801\uC6A9\uD558\uB294 \uC21C\uAC04\uC774 \uC544\uB2C8\uB77C \uADF8 \uB4A4\uC758 install/\uC2E4\uD589\uC5D0\uC11C \uB3D5\uB2C8\uB2E4.`
      });
    }
  }
  return reasons;
}
function describeTargetEscape(worktree, linkPath, target) {
  if (target === "") return "\uD0C0\uAE43\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.";
  if (isAbsolute9(target)) return `\uD0C0\uAE43\uC774 \uC808\uB300 \uACBD\uB85C\uC785\uB2C8\uB2E4: ${target}`;
  const resolved = resolve2(dirname2(join9(worktree, linkPath)), target);
  const rel = relative(worktree, resolved);
  if (rel === "") return `\uD0C0\uAE43\uC774 \uC6CC\uD06C\uD2B8\uB9AC \uB8E8\uD2B8 \uC790\uC2E0\uC785\uB2C8\uB2E4: ${target}`;
  const segments = rel.split(/[\\/]/);
  if (isAbsolute9(rel) || segments[0] === "..") return `\uD0C0\uAE43\uC774 \uC6CC\uD06C\uD2B8\uB9AC \uBC16\uC744 \uAC00\uB9AC\uD0B5\uB2C8\uB2E4: ${target}`;
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return `\uD0C0\uAE43\uC774 \uC800\uC7A5\uC18C \uB0B4\uBD80(.git)\uB97C \uAC00\uB9AC\uD0B5\uB2C8\uB2E4: ${target}`;
  }
  return null;
}
async function inspectPatch(spec, deps = {}) {
  try {
    const options = spec ?? {};
    const files = options.files;
    const worktree = options.worktree;
    const run3 = deps?.run ?? runGit;
    if (!Array.isArray(files)) {
      return blocked2(
        `\uBCC0\uACBD\uB41C \uD30C\uC77C \uBAA9\uB85D\uC774 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4: ${files === null ? "null" : typeof files}`,
        "collectPatch() \uAC00 \uB0B8 `files` \uB97C \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694. \uBAA9\uB85D \uC5C6\uC774\uB294 \uBCC0\uACBD \uBC94\uC704\uB97C \uAC80\uC99D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
      );
    }
    for (const entry of files) {
      if (typeof entry !== "string") {
        return blocked2(
          `\uBCC0\uACBD\uB41C \uD30C\uC77C \uBAA9\uB85D\uC5D0 \uBB38\uC790\uC5F4\uC774 \uC544\uB2CC \uD56D\uBAA9\uC774 \uC788\uC2B5\uB2C8\uB2E4: ${typeof entry}`,
          "collectPatch() \uAC00 \uB0B8 `files` \uB97C \uAC00\uACF5\uD558\uC9C0 \uB9D0\uACE0 \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694."
        );
      }
    }
    if (typeof worktree !== "string" || worktree === "") {
      return blocked2(
        "\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.",
        "`createWorktree()` \uAC00 \uB0B8 \uD578\uB4E4\uC758 `path` \uB97C \uB118\uAE30\uC138\uC694. \uADF8 \uACBD\uB85C \uC5C6\uC774\uB294 \uC2EC\uB9C1\uD06C \uD56D\uBAA9\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
      );
    }
    const reasons = [];
    for (const path of files) reasons.push(...inspectPath(path));
    const listed = await listIndexEntries({ run: run3, worktree });
    if (listed.failure) {
      const stderr = typeof listed.failure?.stderr === "string" ? listed.failure.stderr.trim() : "";
      return blocked2(
        `\uC6CC\uD06C\uD2B8\uB9AC \uC778\uB371\uC2A4\uB97C \uC77D\uC9C0 \uBABB\uD574 \uC2EC\uB9C1\uD06C\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${stderr !== "" ? stderr : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`,
        '\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uD655\uC778\uD558\uC9C0 \uBABB\uD55C \uAC83\uC744 "\uC2EC\uB9C1\uD06C \uC5C6\uC74C" \uC73C\uB85C \uAE30\uB85D\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.'
      );
    }
    const touched = new Set(files);
    for (const entry of listed.entries) {
      if (entry.mode !== "120000") continue;
      if (!touched.has(entry.path)) continue;
      const target = await readBlob({ run: run3, worktree, sha: entry.sha });
      if (target === null) {
        reasons.push({
          path: entry.path,
          rule: "symlink-unreadable",
          detail: "\uC2EC\uBCFC\uB9AD \uB9C1\uD06C\uC778\uB370 \uD0C0\uAE43\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC5B4\uB514\uB97C \uAC00\uB9AC\uD0A4\uB294\uC9C0 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
        });
        continue;
      }
      const escape2 = describeTargetEscape(worktree, entry.path, target.replace(/[\r\n]+$/, ""));
      if (escape2 !== null) reasons.push({ path: entry.path, rule: "symlink-escape", detail: escape2 });
    }
    reasons.push(
      ...await inspectPackageScripts({ run: run3, worktree, baseline: options.baseline, files, entries: listed.entries })
    );
    const flagged = reasons.length > 0;
    const kept = reasons.slice(0, MAX_REASONS);
    const omitted = reasons.length - kept.length;
    const result = { ok: true, flagged, reasons: kept, omitted };
    if (flagged) {
      result.confidence = "disputed";
      result.recovery = buildRecovery(kept, omitted);
    }
    return result;
  } catch (error2) {
    return blocked2(
      `\uD328\uCE58 \uBC94\uC704\uB97C \uAC80\uC0AC\uD558\uB294 \uC911\uC5D0 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4: ${String(error2?.message ?? error2)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uC640 \uD30C\uC77C \uBAA9\uB85D\uC744 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    );
  }
}
function buildRecovery(reasons, omitted) {
  const firstByPath = /* @__PURE__ */ new Map();
  for (const reason of reasons) {
    if (!firstByPath.has(reason.path)) firstByPath.set(reason.path, reason.detail);
  }
  const paths = [...firstByPath.keys()];
  const sample = paths.slice(0, RECOVERY_SAMPLE).map((path) => `${path} \u2014 ${firstByPath.get(path)}`).join(" / ");
  const rest = paths.length > RECOVERY_SAMPLE ? ` \uC678 ${paths.length - RECOVERY_SAMPLE}\uAC1C \uACBD\uB85C` : "";
  const cut2 = omitted > 0 ? ` \uC9C0\uBA74 \uAD00\uACC4\uB85C ${omitted}\uAC74\uC758 \uC0AC\uC720\uB97C \uC0DD\uB7B5\uD588\uC2B5\uB2C8\uB2E4.` : "";
  return `\uD328\uCE58\uB97C \uC801\uC6A9\uD558\uAE30 \uC804\uC5D0 \uC0AC\uB78C\uC774 \uB2E4\uC74C\uC744 \uC9C1\uC811 \uD655\uC778\uD558\uC138\uC694: ${sample}${rest}.${cut2} \uC774\uB7F0 \uD30C\uC77C\uC740 \uC801\uC6A9\uD558\uB294 \uC21C\uAC04\uC774 \uC544\uB2C8\uB77C \uADF8 \uB4A4\uC758 \uC2E4\uD589\uC5D0\uC11C \uBC1C\uD654\uD569\uB2C8\uB2E4.`;
}

// src/reaper.mjs
import { spawn as spawn3 } from "node:child_process";
import { mkdir as mkdir4, readFile as readFile7, readdir, rename as rename5, rm as rm6, stat as stat5, unlink, writeFile as writeFile3 } from "node:fs/promises";
import { isAbsolute as isAbsolute10, join as join11, relative as relative2, resolve as resolve4 } from "node:path";

// src/real-path.mjs
import { realpath as realpathCallback } from "node:fs";
import { basename, dirname as dirname3, join as join10, resolve as resolve3 } from "node:path";
import { promisify } from "node:util";
var realpathNative = promisify(realpathCallback.native);
async function canonical(input) {
  if (typeof input !== "string" || input === "") return null;
  let current = resolve3(input);
  const tail = [];
  for (; ; ) {
    try {
      const real = await realpathNative(current);
      return tail.length === 0 ? real : join10(real, ...tail);
    } catch (error2) {
      if (error2?.code !== "ENOENT") return null;
      const parent = dirname3(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

// src/reaper.mjs
var LEDGER = "children.json";
var WINDOWS2 = process.platform === "win32";
var PROBE_TIMEOUT_MS = 8e3;
function isOurProcess(record2, live) {
  if (!record2 || !live) return false;
  if (record2.pid !== live.pid) return false;
  if (typeof record2.startTime !== "string" || record2.startTime === "") return false;
  if (typeof live.startTime !== "string" || live.startTime === "") return false;
  return record2.startTime === live.startTime;
}
function resolvePosixKillTarget(pid, pgid) {
  return Number.isInteger(pgid) && pgid === pid ? -pid : pid;
}
function classifyOwner(record2, live, selfPid) {
  if (record2?.ownerPid === selfPid) return "us";
  if (live === void 0) return "unknown";
  if (live === null) return "dead";
  return isOurProcess({ pid: record2.ownerPid, startTime: record2.ownerStartTime }, live) ? "alive" : "dead";
}
var SCRATCH_STALE_MS = 6 * 60 * 60 * 1e3;
var SCRATCH_NAMES = Object.freeze([
  /^index-[a-z0-9_-]{1,64}-\d+$/,
  //          index-<runId>-<pid>
  /^state-[a-z0-9_-]{1,64}-\d+\.patch$/,
  //   state-<runId>-<pid>.patch
  /^step-[0-9a-f]{12}-\d+-\d+\.patch$/,
  //    step-<sha12>-<pid>-<seq>.patch
  /^final-[a-z0-9_-]{1,64}-\d+-\d+\.patch$/
  // final-<runId>-<pid>-<seq>.patch
]);
var PATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
var PATCH_NAMES = Object.freeze([/^[a-z0-9][a-z0-9_-]{0,63}\.patch$/]);
var ledgerPath = (stateRoot2) => join11(stateRoot2, LEDGER);
async function readRecords(stateRoot2) {
  try {
    const parsed = JSON.parse(await readFile7(ledgerPath(stateRoot2), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && typeof r === "object" && Number.isInteger(r.pid) && r.pid > 0);
  } catch {
    return [];
  }
}
var writeQueue2 = Promise.resolve();
var tempCounter3 = 0;
async function updateRecords(stateRoot2, mutate) {
  const run3 = async () => {
    try {
      const next = mutate(await readRecords(stateRoot2));
      await mkdir4(stateRoot2, { recursive: true });
      const target = ledgerPath(stateRoot2);
      const temp = `${target}.${process.pid}.${tempCounter3++}.tmp`;
      try {
        await writeFile3(temp, JSON.stringify(next, null, 2), "utf8");
        await rename5(temp, target);
      } catch (error2) {
        await unlink(temp).catch(() => {
        });
        throw error2;
      }
    } catch {
    }
  };
  writeQueue2 = writeQueue2.then(run3, run3);
  return writeQueue2;
}
async function trackChild({ stateRoot: stateRoot2, child, runId, worktree = null, deps = {} }) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const pid = child?.pid;
  if (!Number.isInteger(pid)) return;
  const [startTime, ownerStartTime] = await Promise.all([
    getStartTime(pid).catch(() => null),
    getStartTime(selfPid).catch(() => null)
  ]);
  const record2 = {
    pid,
    startTime: startTime ?? null,
    runId: typeof runId === "string" ? runId : null,
    ownerPid: selfPid,
    ownerStartTime: ownerStartTime ?? null,
    spawnfile: typeof child.spawnfile === "string" ? child.spawnfile : null,
    worktree: typeof worktree === "string" ? worktree : null
  };
  const remove = () => updateRecords(stateRoot2, (records) => records.filter((r) => !(r.pid === pid && r.runId === record2.runId)));
  child.on("exit", () => remove());
  await updateRecords(stateRoot2, (records) => [...records, record2]);
  if (child.exitCode !== null || child.signalCode !== null) await remove();
}
async function trackWorktree({ stateRoot: stateRoot2, runId, worktree, deps = {} }) {
  const { selfPid = process.pid, getStartTime = defaultGetStartTime } = deps;
  const target = await resolveSafeWorktree(stateRoot2, worktree);
  if (target === null) return false;
  const ownerStartTime = await getStartTime(selfPid).catch(() => null);
  await updateRecords(stateRoot2, (records) => [
    ...records.filter((r) => !(r.pid === selfPid && r.runId === runId && r.worktree === target)),
    {
      pid: selfPid,
      startTime: ownerStartTime ?? null,
      runId: typeof runId === "string" ? runId : null,
      ownerPid: selfPid,
      ownerStartTime: ownerStartTime ?? null,
      spawnfile: null,
      worktree: target
    }
  ]);
  return true;
}
async function sweepOrphans({ stateRoot: stateRoot2, deps = {} } = {}) {
  const result = {
    killed: [],
    stale: [],
    skipped: [],
    scratch: { removed: 0, checked: 0 },
    patches: { removed: 0, checked: 0 }
  };
  try {
    const {
      selfPid = process.pid,
      getStartTime = defaultGetStartTime,
      treeKill: kill = treeKill
    } = deps;
    const nowMs = Date.now();
    result.scratch = await sweepScratch(stateRoot2, nowMs);
    result.patches = await sweepPatches(stateRoot2, nowMs);
    const records = await readRecords(stateRoot2);
    if (records.length === 0) return result;
    const done = /* @__PURE__ */ new Set();
    for (const record2 of records) {
      const ownerLive = await lookup(getStartTime, record2.ownerPid);
      const owner = classifyOwner(record2, ownerLive, selfPid);
      if (owner === "alive" || owner === "unknown") {
        result.skipped.push(record2.pid);
        continue;
      }
      const childLive = await lookup(getStartTime, record2.pid);
      if (childLive === void 0) {
        result.skipped.push(record2.pid);
        continue;
      }
      if (childLive !== null && isOurProcess(record2, childLive)) {
        const ok = await kill(record2.pid).catch(() => false);
        if (!ok) {
          result.skipped.push(record2.pid);
          continue;
        }
        result.killed.push(record2.pid);
      } else {
        result.stale.push(record2.pid);
      }
      const target = await resolveSafeWorktree(stateRoot2, record2.worktree);
      if (target !== null) await rm6(target, { recursive: true, force: true }).catch(() => {
      });
      done.add(`${record2.pid}:${record2.runId}`);
    }
    if (done.size > 0) {
      await updateRecords(stateRoot2, (current) => current.filter((r) => !done.has(`${r.pid}:${r.runId}`)));
    }
  } catch {
  }
  return result;
}
function isSafeWorktree(stateRoot2, worktree) {
  if (typeof stateRoot2 !== "string" || stateRoot2 === "") return false;
  if (typeof worktree !== "string" || worktree === "") return false;
  if (!isAbsolute10(worktree)) return false;
  const base = resolve4(stateRoot2, "worktrees");
  const target = resolve4(worktree);
  const rel = relative2(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute10(rel);
}
async function resolveSafeWorktree(stateRoot2, worktree) {
  if (typeof worktree !== "string" || worktree === "" || !isAbsolute10(worktree)) return null;
  const [realRoot, realWorktree] = await Promise.all([canonical(stateRoot2), canonical(worktree)]);
  if (realRoot === null || realWorktree === null) return null;
  return isSafeWorktree(realRoot, realWorktree) ? realWorktree : null;
}
function isUnder(base, target) {
  const rel = relative2(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute10(rel);
}
async function sweepAged({ stateRoot: stateRoot2, name, shapes, maxAgeMs, nowMs }) {
  const empty = { removed: 0, checked: 0 };
  const realRoot = await canonical(stateRoot2);
  if (realRoot === null) return empty;
  const dir = await canonical(join11(realRoot, name));
  if (dir === null || !isUnder(realRoot, dir)) return empty;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return empty;
  }
  let removed = 0;
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !shapes.some((shape) => shape.test(entry.name))) continue;
    checked += 1;
    const full = await canonical(join11(dir, entry.name));
    if (full === null || !isUnder(dir, full)) continue;
    const info = await stat5(full).catch(() => null);
    if (info === null || nowMs - info.mtimeMs < maxAgeMs) continue;
    if (await rm6(full, { force: true }).then(() => true, () => false)) removed += 1;
  }
  return { removed, checked };
}
function sweepScratch(stateRoot2, nowMs) {
  return sweepAged({ stateRoot: stateRoot2, name: "scratch", shapes: SCRATCH_NAMES, maxAgeMs: SCRATCH_STALE_MS, nowMs });
}
function sweepPatches(stateRoot2, nowMs) {
  return sweepAged({ stateRoot: stateRoot2, name: "patches", shapes: PATCH_NAMES, maxAgeMs: PATCH_RETENTION_MS, nowMs });
}
async function lookup(getStartTime, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let startTime;
  try {
    startTime = await getStartTime(pid);
  } catch {
    return void 0;
  }
  if (startTime === void 0) return void 0;
  if (startTime === null) return null;
  return { pid, startTime };
}
function resolveProbePath(basename3) {
  let resolved;
  try {
    resolved = resolveBinary({ basename: basename3 });
  } catch {
    return null;
  }
  return typeof resolved === "string" && isAbsolute10(resolved) ? resolved : null;
}
function runCommand(basename3, args) {
  return new Promise((resolve6) => {
    const command = resolveProbePath(basename3);
    if (command === null) {
      resolve6({
        ok: false,
        stdout: "",
        failed: true,
        timedOut: false,
        error: new Error(`\uD504\uB85C\uBE0C \uC2E4\uD589 \uD30C\uC77C\uC744 PATH \uC5D0\uC11C \uC808\uB300 \uACBD\uB85C\uB85C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${basename3}`)
      });
      return;
    }
    let child;
    try {
      child = spawn3(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error2) {
      resolve6({ ok: false, stdout: "", failed: true, timedOut: false, error: error2 });
      return;
    }
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
      }
    }, PROBE_TIMEOUT_MS);
    child.on("error", (error2) => {
      clearTimeout(timer);
      resolve6({ ok: false, stdout, failed: true, timedOut, error: error2 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve6({ ok: code === 0, stdout, failed: timedOut, timedOut, error: null });
    });
  });
}
async function defaultGetStartTime(pid) {
  if (WINDOWS2) {
    const { ok: ok2, failed: failed2, stdout: stdout2 } = await runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.Ticks } else { 'ABSENT' }`
    ]);
    if (failed2 || !ok2) return void 0;
    const text2 = stdout2.trim();
    if (text2 === "ABSENT") return null;
    return text2 === "" ? void 0 : text2;
  }
  const { ok, failed, stdout } = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (failed) return void 0;
  const text = stdout.trim();
  if (!ok) return text === "" ? null : void 0;
  return text === "" ? null : text;
}
async function treeKill(pid) {
  if (WINDOWS2) {
    const { ok: ok2 } = await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return ok2;
  }
  const { ok, stdout } = await runCommand("ps", ["-o", "pgid=", "-p", String(pid)]);
  const pgid = ok ? Number.parseInt(stdout.trim(), 10) : Number.NaN;
  try {
    process.kill(resolvePosixKillTarget(pid, Number.isNaN(pgid) ? null : pgid), "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

// src/test-runner.mjs
import { spawn as spawn4 } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir as readdir2, readFile as readFile8, stat as stat6 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute as isAbsolute11, join as join12 } from "node:path";
var MAX_OUTPUT_CHARS = 1e5;
var PYTEST_BOOTSTRAP = "import sys,os; sys.path.append(os.getcwd()); import pytest; raise SystemExit(pytest.main(sys.argv[1:]))";
var PYTEST_ENV = Object.freeze({ PYTHONSAFEPATH: "1" });
var CSPROJ_TEST_EVIDENCE = /<IsTestProject>\s*true|Microsoft\.NET\.Test\.Sdk|Microsoft\.Testing\.Platform|Include\s*=\s*"(?:xunit|nunit|mstest)/i;
var DEFAULT_TIMEOUT_MS3 = 6e5;
var KILL_GRACE_MS3 = 3e3;
var DRAIN_GRACE_MS = 3e3;
var DRAIN_MAX_MS = 1e4;
var PROBE_TIMEOUT_MS2 = 1e4;
var WINDOWS3 = process.platform === "win32";
var GENERIC_RECOVERY4 = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
function blocked3(error2, recovery) {
  return { blocked: true, error: error2, recovery: recovery && recovery !== "" ? recovery : GENERIC_RECOVERY4 };
}
function extractMakeTarget(text, target) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith(".")) continue;
    const match = /^([^\s:=][^:=]*)\s*:(?!=)/.exec(line);
    if (!match) continue;
    if (!match[1].trim().split(/\s+/).includes(target)) continue;
    const block = [line.trimEnd()];
    const pending = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.startsWith("	")) {
        block.push(...pending, next.trimEnd());
        pending.length = 0;
        continue;
      }
      if (next.trim() === "") {
        pending.push("");
        continue;
      }
      break;
    }
    return block.join("\n");
  }
  return null;
}
function extractIniSection(text, header) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const out = [lines[start].trim()];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    out.push(lines[i].trimEnd());
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
var PYTEST_SECTION = "[tool.pytest.ini_options]";
var NPM_TEST_SCRIPT = "test";
var normalizeEol = (text) => text.replace(/\r\n/g, "\n");
async function readTextFile(root, name) {
  try {
    return normalizeEol(await readFile8(join12(root, name), "utf8"));
  } catch {
    return null;
  }
}
async function readNpmScript(root, name) {
  const text = await readTextFile(root, "package.json");
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const script = parsed?.scripts?.[name];
  if (typeof script !== "string" || script.trim() === "") return null;
  return script;
}
var readNpmTestScript = (root) => readNpmScript(root, NPM_TEST_SCRIPT);
async function rootFilesBySuffix(root, suffix) {
  try {
    const entries = await readdir2(root, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
async function readDefinitionValue(root, definition) {
  const { file, kind } = definition;
  if (kind === "npm-script") return readNpmScript(root, definition.script ?? NPM_TEST_SCRIPT);
  const text = await readTextFile(root, file);
  if (text === null) return null;
  if (kind === "file-text") return text;
  if (kind === "make-target") return extractMakeTarget(text, NPM_TEST_SCRIPT);
  if (kind === "ini-section") return extractIniSection(text, PYTEST_SECTION);
  return null;
}
function contentDigest(buffer) {
  const normalized = Buffer.from(buffer.toString("binary").replace(/\r\n/g, "\n"), "binary");
  return {
    digest: createHash("sha256").update(normalized).digest("hex"),
    bytes: buffer.length,
    lines: normalized.toString("binary").split("\n").length
  };
}
async function fileDigest(root, name) {
  try {
    return contentDigest(await readFile8(join12(root, name)));
  } catch {
    return null;
  }
}
async function dirDigests(root, relative4, suffix) {
  const out = {};
  let entries;
  try {
    entries = await readdir2(join12(root, relative4), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (typeof suffix === "string" && !entry.name.toLowerCase().endsWith(suffix)) continue;
    if (entry.isSymbolicLink()) out[entry.name] = { digest: "symlink", bytes: 0, lines: 0 };
    else if (entry.isDirectory()) out[entry.name] = { digest: "directory", bytes: 0, lines: 0 };
    else out[entry.name] = await fileDigest(root, join12(relative4, entry.name)) ?? { digest: "unreadable", bytes: 0, lines: 0 };
  }
  return out;
}
var npmScriptPin = (name) => ({ kind: "npm-script", file: "package.json", key: `scripts.${name}`, script: name });
var filePin = (name) => ({ kind: "file-digest", file: name, key: name });
var suffixPin = (suffix) => ({ kind: "dir-digests", file: ".", suffix, key: `\uB8E8\uD2B8\uC758 *${suffix}` });
async function readPinValue(root, entry) {
  if (entry.kind === "npm-script") return readNpmScript(root, entry.script ?? NPM_TEST_SCRIPT);
  if (entry.kind === "file-digest") return fileDigest(root, entry.file);
  if (entry.kind === "dir-digests") return dirDigests(root, entry.file, entry.suffix);
  return null;
}
async function pinExtras(projectPath, entries, deps = {}) {
  const pinned = await Promise.all(
    entries.map(async (entry) => ({ ...entry, value: await readPinValue(projectPath, entry) }))
  );
  const names = pinned.filter((e) => e.kind === "file-digest" && e.value !== null).map((e) => e.file);
  const tracked = names.length === 0 ? /* @__PURE__ */ new Set() : await (deps.trackedPaths ?? trackedPaths)(projectPath, names);
  return pinned.map(
    (entry) => entry.kind === "file-digest" && entry.value !== null ? { ...entry, tracked: tracked === null ? null : tracked.has(entry.file) } : entry
  );
}
async function trackedPaths(projectPath, names) {
  const result = await runGit({ args: ["ls-files", "-z", "--", ...names], cwd: projectPath, timeoutMs: 15e3 });
  if (!result.ok) return null;
  return new Set(result.stdout.split("\0").filter((name) => name !== ""));
}
var NPM_EXTRAS = [
  npmScriptPin("pretest"),
  npmScriptPin("posttest"),
  filePin(".npmrc"),
  // ★ `node --run` 도 `npm run` 도 `node_modules/.bin` 을 PATH **앞**에 붙인다. 자식 env 의
  //   NoDefaultCurrentDirectoryInExePath 는 cwd 만 닫을 뿐 이쪽은 못 막는다(실측:
  //   `.bin\node.cmd` 를 심으니 그것이 이겼다). 이름이 아니라 **내용**을 본다 — 이름만 보면
  //   `scripts.test` 가 부르는 그 이름을 덮어쓰는 것이 구조적으로 통과한다.
  { kind: "dir-digests", file: join12("node_modules", ".bin"), key: "node_modules/.bin" }
];
var CSPROJ_EXTRAS = [
  filePin("Directory.Build.props"),
  filePin("Directory.Build.targets"),
  filePin("Directory.Packages.props"),
  filePin("nuget.config"),
  filePin("NuGet.config"),
  filePin("global.json"),
  // MSBuild 는 작업 디렉터리의 자동 응답 파일을 **명령줄에 그대로 붙인다.** 실측: 한 줄
  // (`-p:IsTestProject=false`)이 실패하는 스위트를 exit 0 으로 뒤집었다. 아래 스폰 인자의
  // `-noAutoResponse` 가 이 채널을 닫지만, 워크트리에 새로 생긴 rsp 는 사용자에게 알린다.
  filePin("Directory.Build.rsp"),
  filePin("MSBuild.rsp"),
  // .NET 10 의 `dotnet test` 는 이 파일로 러너를 고른다.
  filePin("dotnet.config"),
  // `dotnet test` 는 cwd 에서 프로젝트/솔루션을 찾는다. 실측 우선순위는 slnx > sln > csproj —
  // 워크트리에 slnx 하나를 두면 고정한 csproj 은 복원조차 되지 않고 다른 프로젝트가 돈다.
  ...[".sln", ".slnx", ".slnf", ".csproj"].map(suffixPin)
];
var MAKE_EXTRAS = ["GNUmakefile", "makefile", "Makefile"].map(filePin);
var PYTEST_EXTRAS = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "conftest.py"].map(filePin);
function defaultResolveTool(basename3) {
  try {
    return resolveBinary({ basename: basename3 });
  } catch {
    return null;
  }
}
function probeNodeRun(execPath) {
  return new Promise((resolve6) => {
    let child;
    try {
      child = spawn4(execPath, ["--run"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch {
      resolve6({ supported: false, decisive: false });
      return;
    }
    let stderr = "";
    let settled = false;
    const settle2 = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve6(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      settle2({ supported: false, decisive: false });
    }, PROBE_TIMEOUT_MS2);
    try {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", () => settle2({ supported: false, decisive: false }));
      child.on("close", () => settle2({ supported: !/bad option/i.test(stderr), decisive: true }));
    } catch {
      try {
        child.kill();
      } catch {
      }
      settle2({ supported: false, decisive: false });
    }
  });
}
var runSupportCache = /* @__PURE__ */ new Map();
async function supportsNodeRun(execPath, deps = {}) {
  if (runSupportCache.has(execPath)) return runSupportCache.get(execPath);
  const { supported, decisive } = await (deps.probeNodeRun ?? probeNodeRun)(execPath);
  if (decisive) runSupportCache.set(execPath, supported);
  return supported;
}
async function findNpmCli(execPath) {
  const candidate = join12(dirname4(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  try {
    return (await stat6(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}
async function npmScriptLaunch(execPath, deps) {
  const supports = deps.supportsNodeRun ?? supportsNodeRun;
  if (await supports(execPath, deps)) {
    return { command: execPath, args: ["--run", NPM_TEST_SCRIPT], launcher: "node --run", exitCodeExact: false };
  }
  const npmCli = await (deps.npmCliPath ?? findNpmCli)(execPath);
  if (npmCli !== null && npmCli !== void 0) {
    return { command: execPath, args: [npmCli, "run", NPM_TEST_SCRIPT], launcher: "npm-cli.js", exitCodeExact: true };
  }
  return {
    command: null,
    args: [],
    launcher: null,
    exitCodeExact: false,
    resolveError: "\uC774 \uB178\uB4DC\uB294 --run \uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uACE0 npm-cli.js \uB3C4 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 package.json \uC758 test \uC2A4\uD06C\uB9BD\uD2B8\uB97C \uC178 \uC5C6\uC774 \uB744\uC6B8 \uBC29\uBC95\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."
  };
}
function toolEntry({ source, definition, tool, label = tool, args, resolveTool, childEnvExtra }) {
  const command = resolveTool(tool);
  return {
    source,
    command: command ?? null,
    args,
    // 이 도구에만 필요한 계산된 자식 환경 변수. allowlist 를 우회하므로 여기서만 정한다.
    ...childEnvExtra ? { childEnvExtra } : {},
    // 실행 파일을 우리가 직접 스폰하므로 종료 코드가 그대로 온다.
    launcher: command ? "direct" : null,
    exitCodeExact: Boolean(command),
    resolveError: command ? null : `${label} \uC744(\uB97C) PATH \uC5D0\uC11C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.`,
    definition
  };
}
async function deriveTestCommand(projectPath, deps = {}) {
  try {
    if (typeof projectPath !== "string" || projectPath === "" || !isAbsolute11(projectPath)) return null;
    const resolveTool = deps.resolveTool ?? defaultResolveTool;
    const execPath = deps.execPath ?? process.execPath;
    const script = await readNpmTestScript(projectPath);
    if (script !== null) {
      const launch = await npmScriptLaunch(execPath, deps);
      return {
        source: "package.json",
        command: launch.command,
        args: launch.args,
        launcher: launch.launcher,
        exitCodeExact: launch.exitCodeExact,
        resolveError: launch.resolveError ?? null,
        definition: {
          file: "package.json",
          kind: "npm-script",
          key: "scripts.test",
          script: NPM_TEST_SCRIPT,
          value: script,
          extras: await pinExtras(projectPath, NPM_EXTRAS)
        }
      };
    }
    const csproj = await rootFilesBySuffix(projectPath, ".csproj");
    if (csproj.length === 1) {
      const text = await readTextFile(projectPath, csproj[0]);
      if (text !== null && CSPROJ_TEST_EVIDENCE.test(text)) {
        return toolEntry({
          source: "csproj",
          tool: "dotnet",
          // `-noAutoResponse` 는 MSBuild 가 작업 디렉터리의 응답 파일을 명령줄에 붙이는
          // 채널을 닫는다(실측: 공격 픽스처가 exit 0 -> exit 1 로 되돌아오고 깨끗한
          // 프로젝트는 그대로 돈다).
          args: ["test", "-noAutoResponse"],
          resolveTool,
          definition: {
            file: csproj[0],
            kind: "file-text",
            key: csproj[0],
            value: text,
            extras: await pinExtras(projectPath, CSPROJ_EXTRAS)
          }
        });
      }
    }
    for (const name of ["Makefile", "makefile"]) {
      const text = await readTextFile(projectPath, name);
      if (text === null) continue;
      const target = extractMakeTarget(text, NPM_TEST_SCRIPT);
      if (target === null) break;
      return toolEntry({
        source: "Makefile",
        tool: "make",
        args: [NPM_TEST_SCRIPT],
        resolveTool,
        definition: {
          file: name,
          kind: "make-target",
          key: "test \uD0C0\uAE43",
          value: target,
          extras: await pinExtras(projectPath, MAKE_EXTRAS)
        }
      });
    }
    const pytestIni = await readTextFile(projectPath, "pytest.ini");
    if (pytestIni !== null) {
      return toolEntry({
        source: "pytest.ini",
        tool: "python",
        label: "python/python3",
        args: ["-c", PYTEST_BOOTSTRAP],
        childEnvExtra: PYTEST_ENV,
        resolveTool: (name) => resolveTool(name) ?? resolveTool("python3"),
        definition: {
          file: "pytest.ini",
          kind: "file-text",
          key: "pytest.ini",
          value: pytestIni,
          extras: await pinExtras(projectPath, PYTEST_EXTRAS)
        }
      });
    }
    const pyproject = await readTextFile(projectPath, "pyproject.toml");
    if (pyproject !== null) {
      const section = extractIniSection(pyproject, PYTEST_SECTION);
      if (section !== null) {
        return toolEntry({
          source: "pyproject.toml",
          tool: "python",
          label: "python/python3",
          args: ["-c", PYTEST_BOOTSTRAP],
          childEnvExtra: PYTEST_ENV,
          resolveTool: (name) => resolveTool(name) ?? resolveTool("python3"),
          definition: {
            file: "pyproject.toml",
            kind: "ini-section",
            key: PYTEST_SECTION,
            value: section,
            extras: await pinExtras(projectPath, PYTEST_EXTRAS)
          }
        });
      }
    }
    return null;
  } catch {
    return null;
  }
}
async function isDirectory(path) {
  try {
    return (await stat6(path)).isDirectory();
  } catch {
    return false;
  }
}
function endsWithHighSurrogate(text) {
  const code = text.charCodeAt(text.length - 1);
  return code >= 55296 && code <= 56319;
}
function startsWithLowSurrogate(text) {
  const code = text.charCodeAt(0);
  return code >= 56320 && code <= 57343;
}
function createOutputCap(limit) {
  const headLimit = Math.max(1, Math.floor(limit * 0.3));
  const tailLimit = Math.max(1, limit - headLimit);
  let head = "";
  let tail = "";
  let total = 0;
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : String(chunk ?? "");
      if (text === "") return;
      total += text.length;
      if (head.length < headLimit) head += text.slice(0, headLimit - head.length);
      tail += text;
      if (tail.length > tailLimit) tail = tail.slice(tail.length - tailLimit);
    },
    result() {
      if (total <= headLimit + tailLimit) {
        const overlap = head.length + tail.length - total;
        return { text: head + tail.slice(overlap), chars: total, truncated: false };
      }
      const safeHead = endsWithHighSurrogate(head) ? head.slice(0, -1) : head;
      const safeTail = startsWithLowSurrogate(tail) ? tail.slice(1) : tail;
      const dropped = total - safeHead.length - safeTail.length;
      return {
        text: `${safeHead}
\u2026 [\uCD9C\uB825 ${total}\uC790 \uC911 \uAC00\uC6B4\uB370 ${dropped}\uC790\uAC00 \uC798\uB838\uC2B5\uB2C8\uB2E4] \u2026
${safeTail}`,
        chars: total,
        truncated: true
      };
    }
  };
}
var MISSING_DEP_SIGNS = [
  "ERR_MODULE_NOT_FOUND",
  "Cannot find module",
  "Cannot find package",
  "ModuleNotFoundError",
  "No module named",
  "not recognized as an internal or external command",
  "command not found"
];
function spawnFailure(extra) {
  return {
    ran: false,
    exitCode: null,
    signalName: null,
    timedOut: false,
    aborted: false,
    hung: false,
    lingering: false,
    spawnError: null,
    output: "",
    outputChars: 0,
    truncated: false,
    ...extra
  };
}
async function spawnAndCollect({ command, args, cwd, env, signal, timeoutMs, onSpawn }) {
  const cap = createOutputCap(MAX_OUTPUT_CHARS);
  if (signal?.aborted) return spawnFailure({ aborted: true });
  const deadline = timeoutSignal(timeoutMs);
  let child;
  try {
    child = spawn4(command, args, {
      cwd,
      env,
      // ★ 교체다. buildChildEnv 가 만든 것이 자식 환경의 전부다.
      shell: false,
      windowsHide: true,
      // stdin 은 열지 않는다. 입력을 기다리는 스위트가 영영 멈추는 대신 즉시 EOF 를 본다.
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX 에서만: 자식이 자기 프로세스 그룹을 이끌어야 리퍼가 손자까지 끊을 수 있다.
      ...WINDOWS3 ? {} : { detached: true }
    });
  } catch (error2) {
    return spawnFailure({ spawnError: error2 });
  }
  let earlyError = null;
  let settleOutcome = null;
  child.on("error", (error2) => {
    if (settleOutcome !== null) settleOutcome({ spawnError: error2 });
    else earlyError = error2;
  });
  let stopReason = null;
  let finished = false;
  let hardTimer = null;
  let hardSettle = null;
  let drainTimer = null;
  let drainSettle = null;
  let drainDeadline = null;
  const stop = (reason) => {
    if (finished) return;
    if (stopReason === null) stopReason = reason;
    try {
      child.kill();
    } catch {
    }
    if (hardTimer === null) hardTimer = setTimeout(() => hardSettle?.(), KILL_GRACE_MS3);
  };
  const bumpDrain = () => {
    if (finished || drainSettle === null) return;
    clearTimeout(drainTimer);
    const remaining = drainDeadline - Date.now();
    if (remaining <= 0) {
      drainSettle();
      return;
    }
    drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, remaining));
  };
  const onData = (chunk) => {
    cap.push(chunk);
    if (drainTimer !== null) bumpDrain();
  };
  const onAbort = () => stop("aborted");
  const onDeadline = () => stop("timedOut");
  try {
    if (typeof onSpawn === "function") {
      const tracked = onSpawn(child);
      if (tracked && typeof tracked.catch === "function") tracked.catch(() => {
      });
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline?.addEventListener("abort", onDeadline, { once: true });
  } catch (error2) {
    stop("setupFailed");
    try {
      signal?.removeEventListener?.("abort", onAbort);
      deadline?.removeEventListener?.("abort", onDeadline);
    } catch {
    }
    clearTimeout(hardTimer);
    return spawnFailure({ spawnError: error2 });
  }
  const outcome = await new Promise((resolve6) => {
    let settled = false;
    const settle2 = (value) => {
      if (settled) return;
      settled = true;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(drainTimer);
      resolve6(value);
    };
    hardSettle = () => settle2({ hung: true });
    drainSettle = () => settle2({ lingering: true });
    settleOutcome = settle2;
    if (earlyError !== null) settle2({ spawnError: earlyError });
    child.on("exit", () => {
      drainDeadline = Date.now() + DRAIN_MAX_MS;
      drainTimer = setTimeout(() => drainSettle?.(), Math.min(DRAIN_GRACE_MS, DRAIN_MAX_MS));
    });
    child.on("close", () => settle2({}));
  });
  try {
    signal?.removeEventListener?.("abort", onAbort);
    deadline?.removeEventListener?.("abort", onDeadline);
  } catch {
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  const spawnError = outcome.spawnError ?? null;
  const hung = outcome.hung === true;
  const exitCode = spawnError !== null ? null : child.exitCode;
  const cutShort = spawnError === null && exitCode !== 0;
  const collected = cap.result();
  return {
    ran: spawnError === null,
    exitCode,
    signalName: child.signalCode ?? null,
    timedOut: stopReason === "timedOut" && cutShort,
    aborted: stopReason === "aborted" && cutShort,
    hung,
    // 자식은 끝났는데 파이프를 쥔 손자가 남았다. `hung`("결과를 못 받았다")과 다른 사실이다.
    lingering: outcome.lingering === true,
    spawnError,
    output: collected.text,
    outputChars: collected.chars,
    truncated: collected.truncated
  };
}
function forMessage(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > 400 ? `${text.slice(0, 400)} \u2026(${text.length}\uC790 \uC911 \uC55E 400\uC790)` : text;
}
function digestSummary(value) {
  if (!value || typeof value !== "object") return "\uC5C6\uC74C";
  if (value.digest === "symlink") return "\uC2EC\uBCFC\uB9AD \uB9C1\uD06C/\uC815\uC158 (\uB0B4\uC6A9\uC744 \uB300\uC870\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4)";
  if (value.digest === "directory") return "\uB514\uB809\uD130\uB9AC";
  if (value.digest === "unreadable") return "\uC77D\uC744 \uC218 \uC5C6\uC74C";
  return `sha256:${value.digest.slice(0, 12)}\u2026 (${value.bytes}\uBC14\uC774\uD2B8, ${value.lines}\uC904)`;
}
function textDigestSummary(value) {
  return digestSummary(contentDigest(Buffer.from(typeof value === "string" ? value : String(value ?? ""), "utf8")));
}
var sameDigest = (a, b) => (a?.digest ?? null) === (b?.digest ?? null);
async function checkExtras(worktree, extras) {
  const notes = [];
  if (!Array.isArray(extras)) return { notes };
  for (const entry of extras) {
    if (!entry || typeof entry !== "object") continue;
    const current = await readPinValue(worktree, entry);
    if (entry.kind === "dir-digests") {
      const pinned2 = entry.value && typeof entry.value === "object" ? entry.value : {};
      for (const [name, value] of Object.entries(current ?? {})) {
        if (sameDigest(pinned2[name], value)) continue;
        const where = typeof entry.suffix === "string" ? "\uC6CC\uD06C\uD2B8\uB9AC \uB8E8\uD2B8\uC758" : `\uC6CC\uD06C\uD2B8\uB9AC\uC758 ${entry.key} \uC5D0 \uC788\uB294`;
        return {
          error: `${where} ${name} \uC774(\uAC00) \uD504\uB85C\uC81D\uD2B8\uC758 \uAC83\uACFC \uB2E4\uB985\uB2C8\uB2E4.
\uD504\uB85C\uC81D\uD2B8: ${digestSummary(pinned2[name])}
\uC6CC\uD06C\uD2B8\uB9AC: ${digestSummary(value)}
\uC774 \uC790\uB9AC\uC5D0 \uB193\uC778 \uD30C\uC77C\uC740 \uC6B0\uB9AC\uAC00 \uBD80\uB974\uB824\uB358 \uBA85\uB839\uC744 \uB300\uC2E0\uD558\uAC70\uB098 \uADF8 \uB3C4\uAD6C\uAC00 \uC77D\uB294 \uC785\uB825\uC744 \uBC14\uAFC9\uB2C8\uB2E4.`
        };
      }
      continue;
    }
    if (entry.kind === "file-digest") {
      const pinned2 = entry.value ?? null;
      if (current === null) {
        if (pinned2 === null) continue;
        if (entry.tracked === true) {
          return {
            error: `\uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uC11C ${entry.key} \uAC00 \uC0AC\uB77C\uC84C\uC2B5\uB2C8\uB2E4 \u2014 \uD504\uB85C\uC81D\uD2B8\uC5D0\uC11C git \uC774 \uCD94\uC801\uD558\uB294 \uD30C\uC77C\uC774\uB77C \uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uB3C4 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4.`
          };
        }
        notes.push(
          `${entry.key} \uAC00 \uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uC788\uC9C0\uB9CC git \uC774 \uCD94\uC801\uD558\uC9C0 \uC54A\uC544 \uC6CC\uD06C\uD2B8\uB9AC\uB85C \uC774\uC2DD\uB418\uC9C0 \uC54A\uC740 \uAC83\uC73C\uB85C \uBD24\uC2B5\uB2C8\uB2E4. \uADF8 \uD30C\uC77C\uC774 \uC2E4\uD589\uC5D0 \uC601\uD5A5\uC744 \uC900\uB2E4\uBA74 \uC774 \uC2E4\uD589\uC740 \uD504\uB85C\uC81D\uD2B8\uC640 \uB2E4\uB978 \uC870\uAC74\uC785\uB2C8\uB2E4.`
        );
        continue;
      }
      if (sameDigest(pinned2, current)) continue;
      return {
        error: pinned2 === null ? `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 ${entry.key} \uB97C \uC0C8\uB85C \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uC5C6\uB358 \uAC83\uC785\uB2C8\uB2E4.
\uC6CC\uD06C\uD2B8\uB9AC: ${digestSummary(current)}` : `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 ${entry.key} \uB97C \uBC14\uAFE8\uC2B5\uB2C8\uB2E4.
\uD504\uB85C\uC81D\uD2B8: ${digestSummary(pinned2)}
\uC6CC\uD06C\uD2B8\uB9AC: ${digestSummary(current)}`
      };
    }
    const pinned = entry.value ?? null;
    if (current === pinned) continue;
    if (pinned === null) {
      return {
        error: `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 ${entry.key} \uB97C \uC0C8\uB85C \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uC5C6\uB358 \uAC83\uC785\uB2C8\uB2E4.
\uD604\uC7AC\uAC12: ${forMessage(current)}`
      };
    }
    if (current === null) return { error: `\uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uC11C ${entry.key} \uAC00 \uC0AC\uB77C\uC84C\uC2B5\uB2C8\uB2E4 \u2014 \uD504\uB85C\uC81D\uD2B8\uC5D0\uB294 \uC788\uC5C8\uC2B5\uB2C8\uB2E4.` };
    return {
      error: `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 ${entry.key} \uB97C \uBC14\uAFE8\uC2B5\uB2C8\uB2E4.
\uACE0\uC815\uAC12: ${forMessage(pinned)}
\uD604\uC7AC\uAC12: ${forMessage(current)}`
    };
  }
  return { notes };
}
var USER_PRIVILEGE_NOTE = "\uC774 \uC2A4\uC704\uD2B8\uB294 \uC0AC\uC6A9\uC790 \uAD8C\uD55C\uC73C\uB85C \uC2E4\uD589\uB410\uACE0 \uD648 \uB514\uB809\uD130\uB9AC \uC804\uCCB4\uB97C \uC77D\uC744 \uC218 \uC788\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uC790\uACA9\uC99D\uBA85 \uD30C\uC77C\uC744 \uD3EC\uD568\uD569\uB2C8\uB2E4. \uC774 \uB7EC\uB108\uC5D0\uB294 \uADF8\uAC83\uC744 \uB9C9\uC744 \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4(\uC124\uACC4 \xA75.8 S1).";
async function cwdLookupWarning(worktree, definition) {
  if (!WINDOWS3) return null;
  const source = definition?.kind === "npm-script" || definition?.kind === "make-target" ? definition.value : null;
  if (typeof source !== "string") return null;
  const recipe = definition.kind === "make-target" ? source.split(/\r?\n/).find((l) => l.startsWith("	")) : source;
  const token = String(recipe ?? "").trim().replace(/^[@\-+]+/, "").split(/\s+/)[0]?.replace(/^["']|["']$/g, "");
  if (!token || token === "" || /[\\/:]/.test(token)) return null;
  const exts = ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")].map((e) => e.trim().toLowerCase());
  const inRoot = [];
  for (const ext of exts) {
    if (await isFile2(join12(worktree, token + ext))) inRoot.push(token + ext);
  }
  if (inRoot.length === 0) return null;
  for (const ext of exts) {
    if (await isFile2(join12(worktree, "node_modules", ".bin", token + ext))) return null;
  }
  return `\uD14C\uC2A4\uD2B8 \uBA85\uB839\uC774 \uC6CC\uD06C\uD2B8\uB9AC \uB8E8\uD2B8\uC758 ${inRoot.join(" / ")} \uC744(\uB97C) \uB9E8\uC774\uB984 "${token}" \uC73C\uB85C \uBD80\uB985\uB2C8\uB2E4. \uC774 \uB7EC\uB108\uC758 \uC790\uC2DD \uD658\uACBD\uC740 \uC2E4\uD589 \uD30C\uC77C \uD0D0\uC0C9\uC5D0\uC11C cwd \uB97C \uBE7C\uBBC0\uB85C(\uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uB193\uC778 \uB3D9\uBA85 \uC2E4\uD589 \uD30C\uC77C\uC774 \uC6B0\uB9AC\uAC00 \uACE0\uB978 \uBA85\uB839\uC744 \uB300\uC2E0\uD558\uB294 \uAC83\uC744 \uB9C9\uB294\uB2E4) \uADF8 \uC774\uB984\uC740 \uD480\uB9AC\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 \u2014 ".\\${token}" \uCC98\uB7FC \uACBD\uB85C \uAD6C\uBD84\uC790\uB97C \uBD99\uC774\uBA74 \uADF8\uB300\uB85C \uB3D5\uB2C8\uB2E4.`;
}
async function isFile2(path) {
  try {
    return (await stat6(path)).isFile();
  } catch {
    return false;
  }
}
async function runTests(spec) {
  try {
    const options = spec && typeof spec === "object" ? spec : {};
    const { worktree, command, definition, source = null, runId, signal } = options;
    const args = options.args ?? [];
    if (typeof worktree !== "string" || worktree === "" || !isAbsolute11(worktree)) {
      return blocked3(
        `\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4: ${JSON.stringify(worktree)}`,
        "\uC6CC\uD06C\uD2B8\uB9AC\uC758 \uC808\uB300 \uACBD\uB85C\uB97C \uC8FC\uC138\uC694. \uC0C1\uB300 \uACBD\uB85C\uB294 \uC774 \uD504\uB85C\uC138\uC2A4\uC758 cwd \uAE30\uC900\uC73C\uB85C \uD480\uB824 \uC5C9\uB6B1\uD55C \uB514\uB809\uD130\uB9AC\uC5D0\uC11C \uB3D5\uB2C8\uB2E4."
      );
    }
    if (!await isDirectory(worktree)) {
      return blocked3(`\uC6CC\uD06C\uD2B8\uB9AC \uB514\uB809\uD130\uB9AC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4: ${worktree}`, "\uC6CC\uD06C\uD2B8\uB9AC\uB97C \uBA3C\uC800 \uB9CC\uB4E0 \uB4A4 \uD14C\uC2A4\uD2B8\uB97C \uB3CC\uB9AC\uC138\uC694.");
    }
    if (typeof command !== "string" || command === "" || !isAbsolute11(command)) {
      const resolveError = options.resolveError;
      if (typeof resolveError === "string" && resolveError !== "") {
        return blocked3(
          resolveError,
          "\uADF8 \uB3C4\uAD6C\uB97C \uC124\uCE58\uD558\uAC70\uB098 PATH \uC5D0 \uB123\uC740 \uB4A4 deriveTestCommand \uBD80\uD130 \uB2E4\uC2DC \uD558\uC138\uC694. \uC774 \uB7EC\uB108\uB294 \uB3C4\uAD6C\uB97C \uB300\uC2E0 \uACE0\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 \u2014 \uCD94\uCE21\uD55C \uB3C4\uAD6C\uB85C \uB0B8 \uACB0\uACFC\uB294 \uAC80\uC99D\uC5D0 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
        );
      }
      return blocked3(
        `\uC2E4\uD589 \uD30C\uC77C\uC774 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4: ${JSON.stringify(command)}`,
        "deriveTestCommand \uAC00 \uB0B8 command \uB97C \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694. \uC774\uB984\uC73C\uB85C \uC2A4\uD3F0\uD558\uBA74 Windows \uC758 libuv \uAC00 \uC790\uC2DD\uC758 cwd(= \uC6CC\uD06C\uD2B8\uB9AC)\uB97C PATH \uBCF4\uB2E4 \uBA3C\uC800 \uB4A4\uC838, \uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uB193\uC778 \uAC19\uC740 \uC774\uB984\uC758 \uC2E4\uD589 \uD30C\uC77C\uC774 \uB3D5\uB2C8\uB2E4."
      );
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      return blocked3("args \uB294 \uBB38\uC790\uC5F4 \uBC30\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", "deriveTestCommand \uAC00 \uB0B8 args \uB97C \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694.");
    }
    if (signal !== void 0 && signal !== null && typeof signal.addEventListener !== "function") {
      return blocked3(
        "signal \uC740 AbortSignal \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4 \u2014 addEventListener \uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.",
        "AbortController \uC790\uCCB4\uAC00 \uC544\uB2C8\uB77C \uADF8 controller.signal \uC744 \uB118\uAE30\uC138\uC694."
      );
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS3;
    const notes = [];
    if (!definition || typeof definition !== "object" || typeof definition.value !== "string") {
      return {
        ...blocked3(
          "\uACE0\uC815\uB41C \uD14C\uC2A4\uD2B8 \uBA85\uB839 \uC815\uC758\uAC00 \uC5C6\uC5B4 \uC6CC\uD06C\uD2B8\uB9AC\uC758 \uBA85\uB839\uC774 \uADF8\uB300\uB85C\uC778\uC9C0 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
          "deriveTestCommand \uC758 \uACB0\uACFC\uB97C definition \uAE4C\uC9C0 \uD3EC\uD568\uD574 \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694. \uD655\uC778\uD558\uC9C0 \uBABB\uD55C \uBA85\uB839\uC740 \uC2E4\uD589\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
        ),
        definitionCheck: "missing"
      };
    }
    const current = await readDefinitionValue(worktree, definition);
    if (current === null) {
      return {
        ...blocked3(
          `\uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uC11C ${definition.file} \uC758 ${definition.key} \uB97C \uC77D\uC9C0 \uBABB\uD574 \uACE0\uC815\uAC12\uACFC \uAC19\uC740\uC9C0 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
          "\uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uADF8 \uD30C\uC77C\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694. \uD655\uC778\uD558\uC9C0 \uBABB\uD55C \uBA85\uB839\uC740 \uC2E4\uD589\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
        ),
        definitionCheck: "unreadable"
      };
    }
    if (current !== definition.value) {
      const show2 = definition.kind === "npm-script" ? forMessage : textDigestSummary;
      return {
        ...blocked3(
          `\uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uD14C\uC2A4\uD2B8 \uBA85\uB839\uC744 \uBC14\uAFE8\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uD06C\uD2B8\uB9AC\uC758 ${definition.file} \uC5D0\uC11C ${definition.key} \uAC00 \uACE0\uC815\uAC12\uACFC \uB2E4\uB985\uB2C8\uB2E4.
\uACE0\uC815\uAC12: ${show2(definition.value)}
\uD604\uC7AC\uAC12: ${show2(current)}`,
          "\uC2E4\uD589\uD558\uC9C0 \uC54A\uACE0 \uBA48\uCDC4\uC2B5\uB2C8\uB2E4. \uBC14\uB010 \uBA85\uB839\uC73C\uB85C \uB0B8 \uACB0\uACFC\uB294 \uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uACE0\uB978 \uBA85\uB839\uC758 \uACB0\uACFC\uB77C \uAC80\uC99D\uC5D0 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uBCC0\uACBD \uB0B4\uC5ED\uC744 \uD655\uC778\uD558\uACE0, \uADF8 \uBCC0\uACBD\uC774 \uC815\uB2F9\uD558\uB2E4\uBA74 \uC0AC\uC6A9\uC790\uAC00 \uD655\uC778\uD55C \uB4A4 \uD504\uB85C\uC81D\uD2B8 \uCABD \uC815\uC758\uB97C \uAC31\uC2E0\uD558\uACE0 \uB2E4\uC2DC \uC720\uB3C4\uD558\uC138\uC694."
        ),
        definitionCheck: "changed"
      };
    }
    const extras = await checkExtras(worktree, definition.extras);
    if (extras.error !== void 0) {
      return {
        ...blocked3(
          extras.error,
          "\uC2E4\uD589\uD558\uC9C0 \uC54A\uACE0 \uBA48\uCDC4\uC2B5\uB2C8\uB2E4. \uACE0\uC815\uD55C \uD14C\uC2A4\uD2B8 \uBA85\uB839\uC740 \uADF8\uB300\uB85C\uC9C0\uB9CC \uAC19\uC740 \uB3C4\uAD6C\uAC00 \uD568\uAED8 \uC77D\uB294 \uC785\uB825\uC774 \uB2EC\uB77C\uC84C\uACE0, \uADF8 \uC785\uB825\uC740 \uC6B0\uB9AC\uAC00 \uB3CC\uB9AC\uB294 \uBA85\uB839\uC744 \uBC14\uAFC9\uB2C8\uB2E4. \uBCC0\uACBD \uB0B4\uC5ED\uC744 \uD655\uC778\uD558\uACE0, \uADF8 \uBCC0\uACBD\uC774 \uC815\uB2F9\uD558\uB2E4\uBA74 \uC0AC\uC6A9\uC790\uAC00 \uD655\uC778\uD55C \uB4A4 \uD504\uB85C\uC81D\uD2B8 \uCABD\uC5D0 \uBC18\uC601\uD558\uACE0 \uB2E4\uC2DC \uC720\uB3C4\uD558\uC138\uC694."
        ),
        definitionCheck: "changed"
      };
    }
    notes.push(...extras.notes);
    const lookupWarning = await cwdLookupWarning(worktree, definition);
    if (lookupWarning !== null) notes.push(lookupWarning);
    const childEnv = buildChildEnv(options.env ?? process.env, {
      authNames: [],
      runId,
      pathPrepend: [dirname4(process.execPath)],
      extra: options.childEnvExtra,
      notes
    });
    const started = Date.now();
    const run3 = await spawnAndCollect({
      command,
      args,
      cwd: worktree,
      env: childEnv,
      signal,
      timeoutMs,
      onSpawn: options.onSpawn
    });
    const durationMs = Date.now() - started;
    const passed = run3.ran ? run3.exitCode === 0 : null;
    let confidence = "verified";
    if (!run3.ran) {
      confidence = "unverified";
      notes.push(`\uD14C\uC2A4\uD2B8 \uBA85\uB839\uC744 \uB744\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${run3.spawnError}`);
    }
    if (run3.timedOut || run3.aborted || run3.hung) confidence = "unverified";
    if (run3.lingering) {
      notes.push(
        "\uC2A4\uC704\uD2B8\uB294 \uB05D\uB0AC\uB294\uB370 \uCD9C\uB825 \uD30C\uC774\uD504\uB97C \uC954 \uBC30\uACBD \uD504\uB85C\uC138\uC2A4\uAC00 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4 \u2014 \uC885\uB8CC \uCF54\uB4DC\uB294 \uC2A4\uC704\uD2B8\uC758 \uAC83\uC774 \uB9DE\uC9C0\uB9CC, \uADF8 \uD504\uB85C\uC138\uC2A4\uB294 \uC6CC\uD06C\uD2B8\uB9AC \uC548\uC5D0\uC11C \uACC4\uC18D \uB3CC\uACE0 \uC774 \uB7EC\uB108\uC5D0\uB294 \uADF8\uAC83\uC744 \uD68C\uC218\uD560 \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
      );
    }
    if (run3.hung) {
      notes.push(
        "\uB04A\uC740 \uB4A4\uC5D0\uB3C4 \uCD9C\uB825 \uD30C\uC774\uD504\uAC00 \uB2EB\uD788\uC9C0 \uC54A\uC544 \uACB0\uACFC\uB97C \uAE30\uB2E4\uB9AC\uC9C0 \uC54A\uACE0 \uB098\uC654\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uD06C\uD2B8\uB9AC \uC548\uC5D0 \uD504\uB85C\uC138\uC2A4\uAC00 \uB0A8\uC544 \uC788\uC744 \uC218 \uC788\uACE0, \uC774 \uB7EC\uB108\uC5D0\uB294 \uADF8\uAC83\uC744 \uD68C\uC218\uD560 \uACBD\uB85C\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
      );
    }
    if (passed === false && lookupWarning !== null) confidence = "unverified";
    if (passed === false && MISSING_DEP_SIGNS.some((sign) => run3.output.includes(sign))) {
      const hasNodeModules = source === "package.json" ? await isDirectory(join12(worktree, "node_modules")) : true;
      if (source !== "package.json" || !hasNodeModules) {
        confidence = "unverified";
        notes.push(
          source === "package.json" ? "\uC6CC\uD06C\uD2B8\uB9AC\uC5D0 node_modules \uAC00 \uC5C6\uC5B4 \uC758\uC874\uC131\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC774 \uB7EC\uB108\uB294 \uC758\uC874\uC131\uC744 \uC124\uCE58\uD558\uC9C0\uB3C4 \uB9C1\uD06C\uD558\uC9C0\uB3C4 \uC54A\uC2B5\uB2C8\uB2E4." : "\uC758\uC874\uC131\uC744 \uCC3E\uC9C0 \uBABB\uD574 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC774 \uB7EC\uB108\uB294 \uC758\uC874\uC131\uC744 \uC124\uCE58\uD558\uC9C0\uB3C4 \uB9C1\uD06C\uD558\uC9C0\uB3C4 \uC54A\uC2B5\uB2C8\uB2E4."
        );
      }
    }
    if (run3.ran) notes.push(USER_PRIVILEGE_NOTE);
    return {
      ran: run3.ran,
      passed,
      exitCode: run3.exitCode,
      // ★ `node --run` 은 비0 종료 코드를 전부 1 로 접는다(실측). 이 필드가 없으면
      //   소비자(엔진·보상 계층)가 exitCode 를 스위트의 값으로 읽는다.
      exitCodeExact: options.exitCodeExact === true,
      launcher: typeof options.launcher === "string" ? options.launcher : null,
      signalName: run3.signalName,
      timedOut: run3.timedOut,
      aborted: run3.aborted,
      hung: run3.hung,
      lingering: run3.lingering,
      spawnError: run3.spawnError,
      output: run3.output,
      outputChars: run3.outputChars,
      truncated: run3.truncated,
      command,
      args,
      source,
      definitionCheck: "match",
      confidence,
      notes,
      durationMs
    };
  } catch (error2) {
    return blocked3(
      `\uD14C\uC2A4\uD2B8 \uB7EC\uB108\uAC00 \uC608\uC0C1\uCE58 \uBABB\uD55C \uC624\uB958\uB85C \uBA48\uCDC4\uC2B5\uB2C8\uB2E4: ${error2}`,
      "\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uC640 deriveTestCommand \uC758 \uACB0\uACFC\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    );
  }
}

// src/worktree.mjs
import { mkdir as mkdir5, readFile as readFile9, rm as rm7, stat as stat7 } from "node:fs/promises";
import { basename as basename2, dirname as dirname5, isAbsolute as isAbsolute12, join as join13, relative as relative3, resolve as resolve5 } from "node:path";
var COMMIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "bom-orch",
  GIT_AUTHOR_EMAIL: "bom-orch@localhost",
  GIT_COMMITTER_NAME: "bom-orch",
  GIT_COMMITTER_EMAIL: "bom-orch@localhost"
});
var WORKTREE_TIMEOUT_MS = 3e5;
var RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var GENERIC_RECOVERY5 = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
function blocked4(error2, recovery) {
  return { blocked: true, error: error2, recovery: recovery && recovery !== "" ? recovery : GENERIC_RECOVERY5 };
}
function gitReason(result) {
  const err = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (err !== "") return err.slice(0, 500);
  const out = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (out !== "") return out.slice(0, 500);
  if (result?.failed) return "git \uC744 \uC2E4\uD589\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  return `git \uC774 \uC885\uB8CC \uCF54\uB4DC ${result?.exitCode} \uB85C \uB05D\uB0AC\uC2B5\uB2C8\uB2E4.`;
}
function normalizePath(value) {
  const slashed = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}
var samePath = (a, b) => normalizePath(a) === normalizePath(b);
async function listRegisteredWorktrees({ run: run3, projectPath }) {
  const got = await run3({
    args: ["worktree", "list", "--porcelain"],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS
  }).catch(() => null);
  if (!got?.ok || typeof got.stdout !== "string") return { ok: false };
  const entries = [];
  for (const raw of got.stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      entries.push({ path: line.slice("worktree ".length), prunable: false });
    } else if ((line === "prunable" || line.startsWith("prunable ")) && entries.length > 0) {
      entries[entries.length - 1].prunable = true;
    }
  }
  return { ok: true, entries };
}
async function looksLikeLinkedWorktree({ run: run3, path }) {
  const got = await run3({
    args: ["rev-parse", "--absolute-git-dir"],
    cwd: path,
    timeoutMs: WORKTREE_TIMEOUT_MS
  }).catch(() => null);
  if (!got?.ok || typeof got.stdout !== "string") return false;
  const gitDir = got.stdout.trim();
  if (gitDir === "") return false;
  return basename2(dirname5(gitDir.replaceAll("\\", "/"))) === "worktrees";
}
var patchSeq = 0;
async function diffToFile({ run: run3, args, cwd, env, patchPath }) {
  const got = await run3({
    args: [...args, `--output=${patchPath}`],
    cwd,
    env,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!got.ok) return { failure: got };
  const size = await stat7(patchPath).then((s) => s.size, () => null);
  if (size === null) {
    return {
      failure: {
        ok: false,
        stdout: "",
        stderr: `git diff \uAC00 \uC131\uACF5\uD588\uB2E4\uACE0 \uBCF4\uACE0\uD588\uB294\uB370 \uD328\uCE58 \uD30C\uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4: ${patchPath}`,
        exitCode: null,
        failed: true,
        timedOut: false
      }
    };
  }
  return { size };
}
async function diffToBytes({ run: run3, args, cwd, env, stateRoot: stateRoot2, tag }) {
  patchSeq += 1;
  const patchPath = join13(stateRoot2, "scratch", `${tag}-${process.pid}-${patchSeq}.patch`);
  try {
    await mkdir5(join13(stateRoot2, "scratch"), { recursive: true });
    const wrote = await diffToFile({ run: run3, args, cwd, env, patchPath });
    if (wrote.failure) return wrote;
    if (wrote.size === 0) return { bytes: Buffer.alloc(0) };
    return { bytes: await readFile9(patchPath) };
  } catch (error2) {
    return { crashed: error2 };
  } finally {
    await rm7(patchPath, { force: true }).catch(() => {
    });
  }
}
var createQueue = Promise.resolve();
var inFlight = 0;
var peakInFlight = 0;
var completed = 0;
function enqueue(body) {
  const job = async () => {
    inFlight += 1;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    try {
      return await body();
    } catch (error2) {
      return blocked4(
        `\uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB9CC\uB4DC\uB294 \uC911\uC5D0 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4: ${String(error2?.message ?? error2)}`,
        "\uC0C1\uD0DC \uB8E8\uD2B8 \uACBD\uB85C\uC5D0 \uC4F8 \uC218 \uC788\uB294\uC9C0, \uB514\uC2A4\uD06C\uC5D0 \uACF5\uAC04\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      );
    } finally {
      inFlight -= 1;
      completed += 1;
    }
  };
  createQueue = createQueue.then(job, job);
  return createQueue;
}
async function createWorktree(spec) {
  return enqueue(async () => {
    const options = spec ?? {};
    const projectPath = options.projectPath;
    const stateRoot2 = options.stateRoot;
    const runId = options.runId;
    const deps = options.deps ?? {};
    const run3 = deps.run ?? runGit;
    if (typeof projectPath !== "string" || projectPath === "") {
      return blocked4("\uD504\uB85C\uC81D\uD2B8 \uACBD\uB85C\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.", "\uC808\uB300 \uACBD\uB85C\uB97C \uC9C0\uC815\uD558\uC138\uC694.");
    }
    if (typeof stateRoot2 !== "string" || stateRoot2 === "") {
      return blocked4("\uC0C1\uD0DC \uB8E8\uD2B8 \uACBD\uB85C\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.", "\uC808\uB300 \uACBD\uB85C\uB97C \uC9C0\uC815\uD558\uC138\uC694.");
    }
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      return blocked4(
        `\uC2E4\uD589 ID \uAC00 \uC6CC\uD06C\uD2B8\uB9AC \uB514\uB809\uD130\uB9AC \uC774\uB984\uC73C\uB85C \uC4F8 \uC218 \uC5C6\uB294 \uAC12\uC785\uB2C8\uB2E4: ${JSON.stringify(runId)}`,
        "\uC18C\uBB38\uC790/\uC22B\uC790\uB85C \uC2DC\uC791\uD558\uACE0 \uC18C\uBB38\uC790\xB7\uC22B\uC790\xB7`_`\xB7`-` \uB9CC \uC4F0\uB294 64\uC790 \uC774\uB0B4\uC758 \uC774\uB984\uC744 \uC8FC\uC138\uC694 (\uB300\uBB38\uC790\uC640 `.` \uB294 Windows \uAC00 \uAC19\uC740 \uB514\uB809\uD130\uB9AC\uB85C \uC811\uAE30 \uB54C\uBB38\uC5D0 \uBC1B\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4)."
      );
    }
    const realProject = await canonical(projectPath);
    const realStateRoot = await canonical(stateRoot2);
    if (realProject === null || realStateRoot === null) {
      return blocked4(
        `\uACBD\uB85C\uB97C \uC2E4\uCCB4 \uACBD\uB85C\uB85C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${realProject === null ? projectPath : stateRoot2}`,
        "\uACBD\uB85C\uAC00 \uC874\uC7AC\uD558\uACE0 \uC77D\uC744 \uC218 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694. \uD655\uC778\uD558\uC9C0 \uBABB\uD55C \uACBD\uB85C\uC5D0\uB294 \uC190\uB300\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
      );
    }
    const rel = relative3(realProject, realStateRoot);
    const firstSegment = rel.split(/[\\/]/)[0];
    const isOutside = rel !== "" && (isAbsolute12(rel) || firstSegment === "..");
    if (!isOutside) {
      return blocked4(
        `\uC0C1\uD0DC \uB8E8\uD2B8\uAC00 \uB300\uC0C1 \uC800\uC7A5\uC18C \uC548\uC5D0 \uC788\uC2B5\uB2C8\uB2E4: ${realStateRoot} (\uD504\uB85C\uC81D\uD2B8: ${realProject})`,
        "BOM_ORCH_HOME \uC744 \uD504\uB85C\uC81D\uD2B8 \uBC16\uC758 \uC808\uB300 \uACBD\uB85C\uB85C \uC9C0\uC815\uD558\uC138\uC694. \uC800\uC7A5\uC18C \uC548\uC5D0 \uB450\uBA74 \uC6CC\uD06C\uD2B8\uB9AC\uB07C\uB9AC \uC11C\uB85C\uB97C \uBCF4\uACE0 \uCD5C\uC885 \uD328\uCE58\uAC00 \uC0AC\uC6A9\uC790 \uC800\uC7A5\uC18C\uC5D0 \uC0C1\uD0DC \uB8E8\uD2B8\uB97C \uC368 \uB123\uC2B5\uB2C8\uB2E4."
      );
    }
    const worktreePath = join13(realStateRoot, "worktrees", runId);
    if (!isSafeWorktree(realStateRoot, worktreePath)) {
      return blocked4(
        `\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uAC00 \uC0C1\uD0DC \uB8E8\uD2B8 \uBC16\uC744 \uAC00\uB9AC\uD0B5\uB2C8\uB2E4: ${worktreePath}`,
        "\uC2E4\uD589 ID \uC5D0 \uACBD\uB85C \uAD6C\uBD84\uC790\uB098 `..` \uB97C \uB123\uC9C0 \uB9C8\uC138\uC694."
      );
    }
    const state = { owned: false };
    try {
      return await createBody({
        run: run3,
        projectPath: realProject,
        stateRoot: realStateRoot,
        runId,
        worktreePath,
        state
      });
    } catch (error2) {
      if (state.owned) {
        await discard({
          run: run3,
          projectPath: realProject,
          stateRoot: realStateRoot,
          worktreePath: state.path ?? worktreePath
        });
      }
      return blocked4(
        `\uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB9CC\uB4DC\uB294 \uC911\uC5D0 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4: ${String(error2?.message ?? error2)}`,
        "\uC0C1\uD0DC \uB8E8\uD2B8 \uACBD\uB85C\uC5D0 \uC4F8 \uC218 \uC788\uB294\uC9C0, \uB514\uC2A4\uD06C\uC5D0 \uACF5\uAC04\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      );
    }
  });
}
async function createBody({ run: run3, projectPath, stateRoot: stateRoot2, runId, worktreePath: requested, state }) {
  const scratch = join13(stateRoot2, "scratch");
  await mkdir5(join13(stateRoot2, "worktrees"), { recursive: true });
  await mkdir5(scratch, { recursive: true });
  const worktreePath = await canonical(requested);
  if (worktreePath === null || !isSafeWorktree(stateRoot2, worktreePath)) {
    return blocked4(
      `\uC6CC\uD06C\uD2B8\uB9AC \uACBD\uB85C\uC758 \uC2E4\uCCB4\uAC00 \uC0C1\uD0DC \uB8E8\uD2B8 \uBC16\uC744 \uAC00\uB9AC\uD0B5\uB2C8\uB2E4: ${requested}`,
      "\uC0C1\uD0DC \uB8E8\uD2B8 \uC544\uB798 `worktrees/` \uC5D0 \uB2E4\uB978 \uACF3\uC744 \uAC00\uB9AC\uD0A4\uB294 \uB9C1\uD06C\uAC00 \uAC78\uB824 \uC788\uC9C0 \uC54A\uC740\uC9C0 \uD655\uC778\uD558\uC138\uC694."
    );
  }
  const before = await listRegisteredWorktrees({ run: run3, projectPath });
  const live = before.ok ? before.entries.find((entry) => samePath(entry.path, worktreePath)) : void 0;
  if (live !== void 0 && !live.prunable) {
    return blocked4(
      `\uC774 \uACBD\uB85C\uB294 \uB2E4\uB978 \uC2E4\uD589\uC774 \uC4F0\uACE0 \uC788\uC2B5\uB2C8\uB2E4(\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uB4F1\uB85D\uB3FC \uC788\uC2B5\uB2C8\uB2E4): ${worktreePath}`,
      "\uB2E4\uB978 \uC2E4\uD589 ID \uB97C \uC4F0\uAC70\uB098, \uADF8 \uC2E4\uD589\uC774 \uB05D\uB09C \uB4A4\uC5D0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC774 \uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uB294 \uB2E4\uB978 \uC2E4\uD589\uC758 \uC791\uC5C5 \uACB0\uACFC\uAC00 \uB4E4\uC5B4 \uC788\uC744 \uC218 \uC788\uC5B4 \uC9C0\uC6B0\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    );
  }
  if (live !== void 0) {
    const reclaimed = await run3({
      args: ["worktree", "remove", "--force", worktreePath],
      cwd: projectPath,
      timeoutMs: WORKTREE_TIMEOUT_MS
    });
    const after = await listRegisteredWorktrees({ run: run3, projectPath });
    if (!after.ok || after.entries.some((entry) => samePath(entry.path, worktreePath))) {
      return blocked4(
        `\uC55E\uC120 \uC2E4\uD589\uC774 \uB0A8\uAE34 \uC8FD\uC740 \uC6CC\uD06C\uD2B8\uB9AC \uB4F1\uB85D\uC744 \uD68C\uC218\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${worktreePath} (${gitReason(reclaimed)})`,
        `\uB300\uC0C1 \uC800\uC7A5\uC18C\uC5D0\uC11C \`git worktree prune\` \uC744 \uB3CC\uB9AC\uAC70\uB098 \uB2E4\uB978 \uC2E4\uD589 ID \uB97C \uC4F0\uC138\uC694.`
      );
    }
  }
  const created = await run3({
    args: ["worktree", "add", "-q", "--detach", worktreePath, "HEAD"],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!created.ok) {
    if (before.ok && !await looksLikeLinkedWorktree({ run: run3, path: worktreePath })) {
      await discard({ run: run3, projectPath, stateRoot: stateRoot2, worktreePath });
    }
    return blocked4(
      `\uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(created)}`,
      "git \uC800\uC7A5\uC18C\uAC00 \uB9DE\uB294\uC9C0, \uCEE4\uBC0B\uC774 \uCD5C\uC18C 1\uAC1C \uC788\uB294\uC9C0, \uAC19\uC740 \uC774\uB984\uC758 \uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uB0A8\uC544 \uC788\uC9C0 \uC54A\uC740\uC9C0 \uD655\uC778\uD558\uC138\uC694. \uC2E4\uD589 ID \uAC00 \uC774 \uC6B4\uC601\uCCB4\uC81C\uC5D0\uC11C \uB514\uB809\uD130\uB9AC \uC774\uB984\uC73C\uB85C \uC4F8 \uC218 \uC788\uB294 \uAC12\uC778\uC9C0\uB3C4 \uBCF4\uC138\uC694 (Windows \uB294 `nul`\xB7`con`\xB7`aux`\xB7`prn`\xB7`com1`~`com9`\xB7`lpt1`~`lpt9` \uB97C \uAC70\uBD80\uD569\uB2C8\uB2E4)."
    );
  }
  state.owned = true;
  state.path = worktreePath;
  const ignoredPaths = await collectIgnoredPaths({ run: run3, cwd: projectPath });
  const sharedRules = await collectSharedRules({ run: run3, cwd: worktreePath });
  const transplanted = await transplant({ run: run3, projectPath, worktreePath, scratch, runId });
  if (transplanted.blocked) {
    await discard({ run: run3, projectPath, stateRoot: stateRoot2, worktreePath });
    return transplanted;
  }
  const baseline = await commitAll({ run: run3, worktreePath, label: `bom-orch baseline ${runId}` });
  if (baseline.blocked) {
    await discard({ run: run3, projectPath, stateRoot: stateRoot2, worktreePath });
    return baseline;
  }
  return {
    ok: true,
    path: worktreePath,
    projectPath,
    stateRoot: stateRoot2,
    runId,
    baseline: baseline.commit,
    lastSnapshot: baseline.commit,
    transplanted: transplanted.applied,
    ignoredPaths,
    sharedRules
  };
}
async function collectSharedRules({ run: run3, cwd }) {
  const got = await run3({
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!got.ok || typeof got.stdout !== "string") return null;
  const commonDir = got.stdout.trim();
  if (commonDir === "") return null;
  const found = [];
  for (const name of ["info/exclude", "info/attributes"]) {
    const text = await readFile9(join13(commonDir, ...name.split("/")), "utf8").catch(() => null);
    if (text === null) continue;
    const meaningful = text.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    });
    if (meaningful) found.push(name);
  }
  return found;
}
async function transplant({ run: run3, projectPath, worktreePath, scratch, runId }) {
  const indexPath = join13(scratch, `index-${runId}-${process.pid}`);
  const patchPath = join13(scratch, `state-${runId}-${process.pid}.patch`);
  await rm7(indexPath, { force: true });
  try {
    const env = { GIT_INDEX_FILE: indexPath };
    const readTree = await run3({
      args: ["read-tree", "HEAD"],
      cwd: projectPath,
      env,
      timeoutMs: WORKTREE_TIMEOUT_MS
    });
    if (!readTree.ok) {
      return blocked4(
        `\uC0C1\uD0DC \uC774\uC2DD\uC6A9 \uC784\uC2DC \uC778\uB371\uC2A4\uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(readTree)}`,
        "\uB300\uC0C1 \uC800\uC7A5\uC18C\uC758 HEAD \uAC00 \uC815\uC0C1\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      );
    }
    const staged = await run3({ args: ["add", "-A"], cwd: projectPath, env, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!staged.ok) {
      return blocked4(
        `\uC0C1\uD0DC \uC774\uC2DD\uC744 \uC704\uD574 \uB85C\uCEEC \uBCC0\uACBD\uC744 \uBAA8\uC73C\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(staged)}`,
        "\uB300\uC0C1 \uC800\uC7A5\uC18C\uC5D0 \uC77D\uC744 \uC218 \uC5C6\uB294 \uD30C\uC77C\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
      );
    }
    const patch = await diffToFile({
      run: run3,
      args: ["diff", "--cached", "--binary", "HEAD"],
      cwd: projectPath,
      env,
      patchPath
    });
    if (patch.failure) {
      return blocked4(
        `\uC0C1\uD0DC \uC774\uC2DD\uC6A9 \uD328\uCE58\uB97C \uB728\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(patch.failure)}`,
        "\uB300\uC0C1 \uC800\uC7A5\uC18C\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
      );
    }
    if (patch.size === 0) return { applied: false };
    const applied = await run3({
      args: ["apply", "--whitespace=nowarn", patchPath],
      cwd: worktreePath,
      timeoutMs: WORKTREE_TIMEOUT_MS
    });
    if (!applied.ok) {
      return blocked4(
        `\uC0AC\uC6A9\uC790\uC758 \uBBF8\uCEE4\uBC0B \uBCC0\uACBD\uC744 \uC6CC\uD06C\uD2B8\uB9AC\uB85C \uC774\uC2DD\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4(\uD328\uCE58 \uC801\uC6A9 \uC2E4\uD328): ${gitReason(applied)}`,
        "\uBCC0\uACBD\uC744 \uCEE4\uBC0B\uD558\uAC70\uB098 \uC2A4\uD0DC\uC2DC\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC774\uC2DD \uC5C6\uC774 \uC9C4\uD589\uD558\uBA74 \uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uC61B \uCF54\uB4DC\uB97C \uACE0\uCE58\uAC8C \uB429\uB2C8\uB2E4."
      );
    }
    return { applied: true };
  } finally {
    await rm7(indexPath, { force: true }).catch(() => {
    });
    await rm7(patchPath, { force: true }).catch(() => {
    });
  }
}
async function commitAll({ run: run3, worktreePath, label }) {
  const head = async () => {
    const got = await run3({ args: ["rev-parse", "--verify", "HEAD"], cwd: worktreePath, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (!got.ok) {
      return blocked4(`\uC6CC\uD06C\uD2B8\uB9AC\uC758 HEAD \uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(got)}`, "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC544\uC9C1 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694.");
    }
    return got.stdout.trim();
  };
  const staged = await run3({ args: ["add", "-A"], cwd: worktreePath, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!staged.ok) {
    return blocked4(`\uC6CC\uD06C\uD2B8\uB9AC\uC758 \uBCC0\uACBD\uC744 \uBAA8\uC73C\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(staged)}`, "\uC6CC\uD06C\uD2B8\uB9AC \uD30C\uC77C \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694.");
  }
  const pending = await run3({
    args: ["diff", "--cached", "--quiet", "HEAD"],
    cwd: worktreePath,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (pending.ok) {
    const commit2 = await head();
    return typeof commit2 === "string" ? { commit: commit2, changed: false } : commit2;
  }
  const committed = await run3({
    args: ["commit", "-qm", label, "--no-verify", "--no-gpg-sign"],
    cwd: worktreePath,
    env: COMMIT_IDENTITY,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!committed.ok) {
    return blocked4(
      `\uC6CC\uD06C\uD2B8\uB9AC \uC2A4\uB0C5\uC0F7 \uCEE4\uBC0B\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(committed)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    );
  }
  const commit = await head();
  return typeof commit === "string" ? { commit, changed: true } : commit;
}
async function discard({ run: run3, projectPath, stateRoot: stateRoot2, worktreePath }) {
  const removal = await run3({
    args: ["worktree", "remove", "--force", worktreePath],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS
  }).catch(() => null);
  if (isSafeWorktree(stateRoot2, worktreePath)) {
    await rm7(worktreePath, { recursive: true, force: true }).catch(() => {
    });
  }
  let listed = null;
  if (removal?.ok !== true) {
    listed = await listRegisteredWorktrees({ run: run3, projectPath });
    if (listed.ok) {
      const stillRegistered = listed.entries.some((entry) => samePath(entry.path, worktreePath));
      const prunables = listed.entries.filter((entry) => entry.prunable);
      const onlyOurs = prunables.length === 1 && samePath(prunables[0].path, worktreePath);
      if (stillRegistered && onlyOurs) {
        await run3({ args: ["worktree", "prune"], cwd: projectPath, timeoutMs: WORKTREE_TIMEOUT_MS }).catch(() => {
        });
        listed = null;
      }
    }
  }
  const removed = await stat7(worktreePath).then(() => false, () => true);
  const after = listed ?? await listRegisteredWorktrees({ run: run3, projectPath });
  const unregistered = after.ok ? !after.entries.some((entry) => samePath(entry.path, worktreePath)) : null;
  return { removed, unregistered };
}
async function snapshotStep(wt, label, deps = {}) {
  const run3 = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;
  const text = typeof label === "string" && label !== "" ? label : "(\uC774\uB984 \uC5C6\uB294 \uC2A4\uD15D)";
  const previous = wt.lastSnapshot;
  const result = await commitAll({ run: run3, worktreePath: wt.path, label: text });
  if (result.blocked) return result;
  const moved = result.commit !== previous;
  if (!moved) {
    return { ok: true, label: text, commit: previous, previous, changed: false, diff: Buffer.alloc(0), files: [] };
  }
  wt.lastSnapshot = result.commit;
  const diff = await diffToBytes({
    run: run3,
    args: ["diff", "--binary", previous, result.commit],
    cwd: wt.path,
    stateRoot: wt.stateRoot,
    tag: `step-${result.commit.slice(0, 12)}`
  });
  if (diff.failure) {
    return blocked4(
      `\uC2A4\uD15D \uC2A4\uB0C5\uC0F7\uC758 diff \uB97C \uB728\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(diff.failure)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694."
    );
  }
  if (diff.crashed) {
    return blocked4(
      `\uC2A4\uD15D \uC2A4\uB0C5\uC0F7\uC758 diff \uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${String(diff.crashed?.message ?? diff.crashed)}`,
      "\uC0C1\uD0DC \uB8E8\uD2B8 \uACBD\uB85C\uC5D0 \uC4F8 \uC218 \uC788\uB294\uC9C0, \uB514\uC2A4\uD06C\uC5D0 \uACF5\uAC04\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
    );
  }
  const names = await run3({
    args: ["diff", "--name-only", "-z", "--no-renames", previous, result.commit],
    cwd: wt.path,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!names.ok) {
    return blocked4(
      `\uC2A4\uD15D \uC2A4\uB0C5\uC0F7\uC758 \uD30C\uC77C \uBAA9\uB85D\uC744 \uB728\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(names)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD558\uC138\uC694. \uBAA9\uB85D \uC5C6\uC774\uB294 \uC774 \uC2A4\uD15D\uC774 \uBB34\uC5C7\uC744 \uAC74\uB4DC\uB838\uB294\uC9C0 \uAC80\uC99D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
    );
  }
  return {
    ok: true,
    label: text,
    commit: result.commit,
    previous,
    changed: true,
    diff: diff.bytes,
    files: names.stdout.split("\0").filter((entry) => entry !== "")
  };
}
async function collectPatch(wt, deps = {}) {
  const run3 = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;
  const staged = await run3({ args: ["add", "-A"], cwd: wt.path, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!staged.ok) {
    return blocked4(`\uCD5C\uC885 \uD328\uCE58\uB97C \uC704\uD574 \uBCC0\uACBD\uC744 \uBAA8\uC73C\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(staged)}`, "\uC6CC\uD06C\uD2B8\uB9AC \uD30C\uC77C \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694.");
  }
  const patch = await diffToBytes({
    run: run3,
    args: ["diff", "--cached", "--binary", wt.baseline],
    cwd: wt.path,
    stateRoot: wt.stateRoot,
    tag: `final-${wt.runId ?? "run"}`
  });
  if (patch.failure) {
    return blocked4(
      `\uCD5C\uC885 \uD328\uCE58\uB97C \uB728\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(patch.failure)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
    );
  }
  if (patch.crashed) {
    return blocked4(
      `\uCD5C\uC885 \uD328\uCE58\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${String(patch.crashed?.message ?? patch.crashed)}`,
      "\uC0C1\uD0DC \uB8E8\uD2B8 \uACBD\uB85C\uC5D0 \uC4F8 \uC218 \uC788\uB294\uC9C0, \uB514\uC2A4\uD06C\uC5D0 \uACF5\uAC04\uC774 \uC788\uB294\uC9C0 \uD655\uC778\uD558\uC138\uC694."
    );
  }
  const names = await run3({
    args: ["diff", "--cached", "--name-only", "-z", "--no-renames", wt.baseline],
    cwd: wt.path,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!names.ok) {
    return blocked4(
      `\uCD5C\uC885 \uD328\uCE58\uC758 \uD30C\uC77C \uBAA9\uB85D\uC744 \uB728\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${gitReason(names)}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uC0C1 \uC0C1\uD0DC\uC778\uC9C0 \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uBAA9\uB85D \uC5C6\uC774\uB294 \uBCC0\uACBD \uBC94\uC704\uB97C \uAC80\uC99D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
    );
  }
  const files = names.stdout.split("\0").filter((entry) => entry !== "");
  return {
    ok: true,
    patch: patch.bytes,
    empty: patch.bytes.length === 0,
    files,
    ignoredPaths: await collectIgnoredPaths({ run: run3, cwd: wt.path }),
    gitlinks: await collectGitlinks({ run: run3, cwd: wt.path })
  };
}
async function collectIgnoredPaths({ run: run3, cwd }) {
  const got = await run3({
    args: ["status", "--porcelain", "-z", "--ignored=matching"],
    cwd,
    timeoutMs: WORKTREE_TIMEOUT_MS
  });
  if (!got.ok || typeof got.stdout !== "string") return null;
  return got.stdout.split("\0").filter((record2) => record2.startsWith("!! ")).map((record2) => record2.slice(3)).filter((entry) => entry !== "");
}
async function collectGitlinks({ run: run3, cwd }) {
  const got = await run3({ args: ["ls-files", "-s", "-z"], cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
  if (!got.ok || typeof got.stdout !== "string") return null;
  const found = [];
  for (const record2 of got.stdout.split("\0")) {
    if (!record2.startsWith("160000 ")) continue;
    const tab = record2.indexOf("	");
    if (tab !== -1) found.push(record2.slice(tab + 1));
  }
  return found;
}
async function listIgnoredPaths(wt, deps = {}) {
  const run3 = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;
  return collectIgnoredPaths({ run: run3, cwd: wt.path });
}
async function removeWorktree(wt, deps = {}) {
  const run3 = deps.run ?? runGit;
  const guard = checkHandle(wt);
  if (guard) return guard;
  const stateRoot2 = await canonical(wt.stateRoot);
  const worktreePath = await canonical(wt.path);
  if (stateRoot2 === null || worktreePath === null || !isSafeWorktree(stateRoot2, worktreePath)) {
    return blocked4(
      `\uC0C1\uD0DC \uB8E8\uD2B8 \uBC16\uC758 \uACBD\uB85C\uB294 \uC9C0\uC6B0\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4: ${wt.path}`,
      "\uC6CC\uD06C\uD2B8\uB9AC\uB294 <\uC0C1\uD0DC \uB8E8\uD2B8>/worktrees/<\uC2E4\uD589 ID> \uC544\uB798\uC5D0\uB9CC \uB9CC\uB4E4\uC5B4\uC9D1\uB2C8\uB2E4."
    );
  }
  const projectPath = await canonical(wt.projectPath) ?? wt.projectPath;
  const result = await discard({ run: run3, projectPath, stateRoot: stateRoot2, worktreePath });
  return { ok: true, removed: result.removed, unregistered: result.unregistered };
}
function checkHandle(wt) {
  if (wt === null || typeof wt !== "object") {
    return blocked4("\uC6CC\uD06C\uD2B8\uB9AC \uD578\uB4E4\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", "createWorktree \uAC00 \uB3CC\uB824\uC900 \uAC12\uC744 \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694.");
  }
  for (const key of ["path", "projectPath", "stateRoot"]) {
    if (typeof wt[key] !== "string" || wt[key] === "") {
      return blocked4(`\uC6CC\uD06C\uD2B8\uB9AC \uD578\uB4E4\uC5D0 ${key} \uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.`, "createWorktree \uAC00 \uB3CC\uB824\uC900 \uAC12\uC744 \uADF8\uB300\uB85C \uB118\uAE30\uC138\uC694.");
    }
  }
  return null;
}

// src/engine.mjs
var WORKER_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Edit", "Write"]);
var VERIFIER_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
var PLANNER_ROLE = "planner";
var MAX_BUDGET = 10;
var MAX_WAIT_MS = 36e5;
var HARD_STOP_GRACE_MS = 1e4;
var HARD_STOP = /* @__PURE__ */ Symbol("bom-orch:hard-stop");
var RUN_ID_PATTERN2 = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var GENERIC_RECOVERY6 = "\uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
var EXCERPT_CHARS = 1200;
var OLD_STEP_EXCERPT_CHARS = 200;
var TEST_OUTPUT_CHARS = 800;
var MAX_REASONS_PER_STEP = 5;
var SUMMARY_FIELD_CHARS = 400;
var AXIS_SUMMARY_LIMIT = 8;
var NOTICE_CHARS = 400;
var NOTICES_TOTAL_CHARS = 1600;
var NOTICE_LIST_ITEMS = 3;
var NOTICE_ITEM_CHARS = 120;
function safeText(value) {
  if (typeof value === "string") return value !== "" ? value : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  try {
    const text = String(value?.message ?? value);
    return text !== "" ? text : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  } catch {
    return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  }
}
function clip(value, limit) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? `${text.slice(0, limit)}\u2026(${text.length}\uC790 \uC911 \uC55E ${limit}\uC790)` : text;
}
function few(list, keep = NOTICE_LIST_ITEMS) {
  if (!Array.isArray(list) || list.length === 0) return "\uC5C6\uC74C";
  const head = list.slice(0, keep).map((item) => {
    const text = typeof item === "string" ? item : show(item);
    return text.length > NOTICE_ITEM_CHARS ? `${text.slice(0, NOTICE_ITEM_CHARS)}\u2026` : text;
  });
  return list.length > keep ? `${head.join(", ")} \uC678 ${list.length - keep}\uAC74` : head.join(", ");
}
function joinNotices(list) {
  if (list.length === 0) return void 0;
  const kept = [];
  let used = 0;
  for (const text of list) {
    if (kept.length > 0 && used + text.length + 1 > NOTICES_TOTAL_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  const dropped = list.length - kept.length;
  return dropped > 0 ? `${kept.join(" ")} (\uADF8 \uBC16\uC5D0 \uC54C\uB9BC ${dropped}\uAC74\uC774 \uB354 \uC788\uC5B4 \uC811\uC5C8\uC2B5\uB2C8\uB2E4.)` : kept.join(" ");
}
function show(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text;
  } catch {
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "(\uD45C\uD604\uD560 \uC218 \uC5C6\uB294 \uAC12)";
  }
}
var isBlocked = (result) => result !== null && typeof result === "object" && result.blocked === true;
var runIdSeq = 0;
function makeRunId({ now = Date.now, random = Math.random } = {}) {
  runIdSeq = (runIdSeq + 1) % 1296;
  const stamp = Math.floor(now()).toString(36);
  const seq = runIdSeq.toString(36).padStart(2, "0");
  const salt = Math.floor(random() * 1679616).toString(36).padStart(4, "0");
  return `run-${stamp}-${seq}${salt}`;
}
var FORWARD_PLACEMENT = "claude>codex";
var REVERSED_PLACEMENT = "codex>claude";
var flipPlacement = (placement) => placement === REVERSED_PLACEMENT ? FORWARD_PLACEMENT : REVERSED_PLACEMENT;
function assignRoles(providers, decisions) {
  const first = providers[0];
  const second = providers[1] ?? null;
  const reversed = decisions?.placement === REVERSED_PLACEMENT;
  if (second === null) return { planner: first, worker: first, verifier: first };
  if (decisions?.mix === "single") {
    const only = reversed ? second : first;
    return { planner: only, worker: only, verifier: only };
  }
  const worker = reversed ? second : first;
  const verifier = reversed ? first : second;
  return { planner: worker, worker, verifier };
}
function crossCheckNotice(worker, verifier, vendorCount) {
  if (typeof worker?.id !== "string" || typeof verifier?.id !== "string" || worker.id !== verifier.id) return null;
  return vendorCount > 1 ? "\uAD50\uCC28\uAC80\uC99D \uC5C6\uC774 \uB2E8\uC77C \uBCA4\uB354\uB85C \uB3CC\uB3C4\uB85D \uBC30\uCE58\uB410\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uCEE4\uC640 \uBCA0\uB9AC\uD30C\uC774\uC5B4\uAC00 \uAC19\uC740 \uBCA4\uB354\uC785\uB2C8\uB2E4. \uC774 \uC2E4\uD589\uC774 \uD55C \uBCA4\uB354\uB9CC \uC4F0\uB3C4\uB85D \uC815\uD574\uC84C\uC2B5\uB2C8\uB2E4(mix=single \uB610\uB294 \uC5ED\uD560 \uC9C0\uC815). \uAD50\uCC28\uAC80\uC99D\uC774 \uD544\uC694\uD558\uBA74 \uADF8 \uC9C0\uC815\uC744 \uBE7C\uC138\uC694." : "\uBCA4\uB354\uAC00 \uD558\uB098\uBFD0\uC774\uB77C \uAD50\uCC28\uAC80\uC99D \uC5C6\uC774 \uB2E8\uC77C \uBCA4\uB354\uB85C \uB3CC\uB3C4\uB85D \uBC30\uCE58\uB410\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uCEE4\uC640 \uBCA0\uB9AC\uD30C\uC774\uC5B4\uAC00 \uAC19\uC740 \uBCA4\uB354\uC785\uB2C8\uB2E4. \uB2E4\uB978 \uBCA4\uB354 CLI \uB97C \uC124\uCE58\uD558\uBA74 \uAD50\uCC28\uAC80\uC99D\uC774 \uCF1C\uC9D1\uB2C8\uB2E4.";
}
var WORKTREE_TIMEOUT_MS2 = 3e5;
async function reclaimOrphanRegistrations({ run: run3, projectPath, stateRoot: stateRoot2 }) {
  const listed = await run3({
    args: ["worktree", "list", "--porcelain"],
    cwd: projectPath,
    timeoutMs: WORKTREE_TIMEOUT_MS2
  }).catch(() => null);
  if (!listed?.ok || typeof listed.stdout !== "string") return { reclaimed: 0, checked: false };
  const entries = [];
  for (const raw of listed.stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) entries.push({ path: line.slice("worktree ".length), prunable: false });
    else if ((line === "prunable" || line.startsWith("prunable ")) && entries.length > 0) {
      entries[entries.length - 1].prunable = true;
    }
  }
  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.prunable) continue;
    if (await resolveSafeWorktree(stateRoot2, entry.path) === null) continue;
    const removed = await run3({
      args: ["worktree", "remove", "--force", entry.path],
      cwd: projectPath,
      timeoutMs: WORKTREE_TIMEOUT_MS2
    }).catch(() => null);
    if (removed?.ok === true) reclaimed += 1;
  }
  return { reclaimed, checked: true };
}
function plannerInstruction({ task, testPlan, evidence }) {
  const testLine = testPlan === null ? "\uC774 \uD504\uB85C\uC81D\uD2B8\uC5D0\uC11C\uB294 \uD14C\uC2A4\uD2B8 \uBA85\uB839\uC744 \uC720\uB3C4\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uAC80\uC99D\uC740 \uC0AC\uB78C\uC774 \uD569\uB2C8\uB2E4." : `\uD14C\uC2A4\uD2B8\uB294 \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130\uAC00 \uC9C1\uC811 \uB3CC\uB9BD\uB2C8\uB2E4: ${testPlan.source} \uC758 \uC815\uC758(${testPlan.definition.key}).`;
  return [
    ...typeof evidence === "string" && evidence !== "" ? [clip(evidence, EXCERPT_CHARS), ""] : [],
    "\uB2E4\uC74C \uC791\uC5C5\uC758 \uC2E4\uD589 \uACC4\uD68D\uC744 \uC138\uC6B0\uC138\uC694. \uB2F9\uC2E0\uC740 \uD30C\uC77C\uC744 \uC77D\uAC70\uB098 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uD14D\uC2A4\uD2B8 \uACC4\uD68D\uB9CC \uB0C5\uB2C8\uB2E4.",
    "",
    `\uC791\uC5C5: ${task}`,
    "",
    testLine,
    "\uACC4\uD68D\uC744 \uC2E4\uD589\uD560 \uC6CC\uCEE4\uB294 \uC178\uC744 \uC4F8 \uC218 \uC5C6\uACE0 \uD30C\uC77C \uC77D\uAE30\xB7\uC4F0\uAE30\xB7\uAC80\uC0C9\uB9CC \uD569\uB2C8\uB2E4. \uD14C\uC2A4\uD2B8 \uBA85\uB839\uC744 \uBC14\uAFB8\uB77C\uACE0",
    "\uC9C0\uC2DC\uD558\uC9C0 \uB9C8\uC138\uC694 \u2014 \uBC14\uB00C\uBA74 \uC2E4\uD589\uC774 \uAC70\uBD80\uB429\uB2C8\uB2E4.",
    "",
    "\uBB34\uC5C7\uC744 \uC5B4\uB5A4 \uC21C\uC11C\uB85C \uACE0\uCE60\uC9C0, \uBB34\uC5C7\uC744 \uADFC\uAC70\uB85C \uB2E4 \uB410\uB2E4\uACE0 \uD310\uB2E8\uD560\uC9C0 \uC9E7\uAC8C \uC801\uC73C\uC138\uC694."
  ].join("\n");
}
function workerInstruction({ task, plan, step, budget, feedback }) {
  const lines = [
    `\uC791\uC5C5: ${task}`,
    "",
    "\uACC4\uD68D:",
    clip(plan, EXCERPT_CHARS),
    "",
    `\uC774\uBC88\uC740 ${step}/${budget} \uBC88\uC9F8 \uC2A4\uD15D\uC785\uB2C8\uB2E4. \uB2F9\uC2E0\uC740 \uC77C\uD68C\uC6A9 \uC6CC\uD06C\uD2B8\uB9AC \uC548\uC5D0\uC11C \uC77C\uD569\uB2C8\uB2E4 \u2014`,
    "\uC774 \uB514\uB809\uD130\uB9AC \uBC16\uC740 \uBCF4\uC774\uC9C0\uB3C4 \uB2FF\uC9C0\uB3C4 \uC54A\uC2B5\uB2C8\uB2E4. \uC178\uC740 \uC5C6\uC2B5\uB2C8\uB2E4.",
    "\uD14C\uC2A4\uD2B8\uB294 \uC774 \uC2E4\uD589\uC774 \uB05D\uB09C \uB4A4 \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uD130\uAC00 \uC9C1\uC811 \uB3CC\uB9BD\uB2C8\uB2E4. \uD14C\uC2A4\uD2B8 \uC815\uC758(package.json \uC758",
    "scripts.test, Makefile \uC758 test \uD0C0\uAE43, pytest \uC124\uC815 \uB4F1)\uB97C \uACE0\uCE58\uC9C0 \uB9C8\uC138\uC694 \u2014 \uACE0\uCE58\uBA74 \uC2E4\uD589\uC774 \uAC70\uBD80\uB429\uB2C8\uB2E4."
  ];
  if (feedback !== null) {
    lines.push("", "\uC55E \uC2A4\uD15D\uC758 \uACB0\uACFC:", clip(feedback, EXCERPT_CHARS));
  }
  return lines.join("\n");
}
function verifierInstruction({ task, plan, files, tests }) {
  return [
    "\uC544\uB798 \uC791\uC5C5\uC758 \uACB0\uACFC\uB97C \uAC80\uD1A0\uD558\uC138\uC694. \uB2F9\uC2E0\uC740 \uC77D\uAE30\uB9CC \uD569\uB2C8\uB2E4 \u2014 \uD30C\uC77C\uC744 \uACE0\uCE58\uC9C0 \uB9C8\uC138\uC694.",
    "\uACE0\uCE58\uBA74 \uD0D0\uC9C0\uB418\uACE0 \uB2F9\uC2E0\uC758 \uD310\uC815\uC740 \uC2E0\uB8B0\uB3C4 \uB0AE\uC74C\uC73C\uB85C \uAE30\uB85D\uB429\uB2C8\uB2E4.",
    "",
    `\uC791\uC5C5: ${task}`,
    "",
    "\uACC4\uD68D:",
    clip(plan, EXCERPT_CHARS),
    "",
    `\uC774\uBC88 \uC2A4\uD15D\uC774 \uAC74\uB4DC\uB9B0 \uD30C\uC77C: ${files.length === 0 ? "(\uC5C6\uC74C)" : files.join(", ")}`,
    "",
    "\uD14C\uC2A4\uD2B8 \uACB0\uACFC:",
    clip(tests, EXCERPT_CHARS),
    "",
    "\uC791\uC5C5\uC774 \uC2E4\uC81C\uB85C \uB05D\uB0AC\uB294\uC9C0, \uBE60\uC9C4 \uAC83\uC774\uB098 \uC798\uBABB\uB41C \uAC83\uC774 \uC788\uB294\uC9C0 \uC801\uC73C\uC138\uC694."
  ].join("\n");
}
function renderContent(payload) {
  const levels = [
    (p) => p,
    (p) => ({ ...p, steps: p.steps.map(stripStepText) }),
    (p) => ({ ...p, plan: { ...p.plan, content: "" }, steps: p.steps.map(stripStepText) }),
    // ★ 여기서부터 **경로 목록**을 줄인다. 앞 단계들은 텍스트만 비우는데, 상한을 넘기는
    //   실제 원인은 `patch.files`(테스트가 남긴 산출물까지 섞여 들어온다)와
    //   `scope.reasons`(patch-scope 의 상한이 100건이다) 같은 목록이다. 실측: 50자짜리
    //   현실적 경로 200개만으로 잘린 JSON 이 나갔다.
    (p) => trim(p, 40, 10),
    (p) => trim({ ...p, plan: { ...p.plan, content: "" }, steps: [], stepsOmitted: p.steps.length }, 10, 3),
    // ★ 마지막은 **입력 크기에 비례하지 않는 고정 요약**이다. 앞 단계가 전부 상한을
    //   넘기면 여기로 오고, 여기서도 넘기면 잘린 JSON — 즉 파싱 불가능한 content —
    //   이 나간다.
    //
    //   ★ 문자열도 반드시 자른다. "목록만 줄이면 된다"는 틀렸다: 목록이 짧아도 **원소
    //     하나가** 거대할 수 있고(경로 이름은 델리게이트가 정한다), `patch.path` 조차
    //     상태 루트 설정에 따라 길어진다. 자르지 않았더니 이 단계의 출력이 20,176자로
    //     나왔다 — 정확히 이 단계가 막으려던 결과다.
    (p) => ({
      runId: clip(p.runId, SUMMARY_FIELD_CHARS),
      stopReason: clip(p.stopReason, SUMMARY_FIELD_CHARS),
      stepCount: p.stepCount,
      patch: {
        path: clip(p.patch.path, SUMMARY_FIELD_CHARS),
        bytes: p.patch.bytes,
        empty: p.patch.empty,
        fileCount: count2(p.patch.files)
      },
      scope: { flagged: p.scope.flagged, reasonCount: count2(p.scope.reasons) },
      // ★ 학습 사실은 마지막 단계에서도 남긴다. §7 의 결정과 그 반영 여부는 이 봉투에만 있는
      //   정보이고(저널은 사용자가 따로 열어야 한다), 크기는 `AXES` 로 묶여 있다 — 축 넷 ×
      //   짧은 팔 이름이다. 다만 팔 문자열은 **라이브러리 호출자가 정할 수 있으므로**
      //   (`options.decisions.placement`) 값마다 잘라야 이 단계의 "입력 크기에 비례하지
      //   않는다" 가 유지된다. 실측(자르기 없이): 팔에 100,000자를 넣으면 이 단계가
      //   400,038자를 냈다 — 정확히 이 단계가 막으려던 결과다.
      ...p.learning !== null && typeof p.learning === "object" ? { learning: summarizeLearning(p.learning) } : {},
      truncatedReport: true
    })
  ];
  let last = "";
  for (const level of levels) {
    last = JSON.stringify(level(payload));
    if (typeof last === "string" && last.length <= MAX_CONTENT_CHARS) return last;
  }
  return last;
}
var count2 = (value) => Array.isArray(value) ? value.length : 0;
var clipOrNull = (value) => typeof value === "string" ? clip(value, SUMMARY_FIELD_CHARS) : null;
function clipArms(map) {
  if (map === null || typeof map !== "object") return {};
  return Object.fromEntries(
    Object.entries(map).slice(0, AXIS_SUMMARY_LIMIT).map(([axis, arm]) => [clip(axis, SUMMARY_FIELD_CHARS), clipOrNull(arm)])
  );
}
function summarizeLearning(learning) {
  const applied = learning.applied;
  return {
    taskClass: clipOrNull(learning.taskClass),
    decisions: clipArms(learning.decisions),
    sources: clipArms(learning.sources),
    applied: applied === null || typeof applied !== "object" ? null : {
      grade: clipOrNull(applied.grade),
      axes: (Array.isArray(applied.axes) ? applied.axes : []).slice(0, AXIS_SUMMARY_LIMIT).map((axis) => clip(axis, SUMMARY_FIELD_CHARS))
    }
  };
}
function cut(list, keep) {
  if (!Array.isArray(list) || list.length <= keep) return { list, omitted: 0 };
  return { list: list.slice(0, keep), omitted: list.length - keep };
}
function trim(payload, keepFiles, keepReasons) {
  const files = cut(payload.patch.files, keepFiles);
  const ignored = cut(payload.patch.ignoredPaths, keepFiles);
  const gitlinks = cut(payload.patch.gitlinks, keepReasons);
  const wtIgnored = cut(payload.worktree?.ignoredPaths, keepReasons);
  const reasons = cut(payload.scope.reasons, keepReasons);
  const blockers = cut(payload.blockers, keepReasons);
  return {
    ...payload,
    patch: {
      ...payload.patch,
      files: files.list,
      filesOmitted: files.omitted,
      ignoredPaths: ignored.list,
      ignoredPathsOmitted: ignored.omitted,
      gitlinks: gitlinks.list,
      gitlinksOmitted: gitlinks.omitted
    },
    worktree: { ...payload.worktree, ignoredPaths: wtIgnored.list, ignoredPathsOmitted: wtIgnored.omitted },
    scope: { ...payload.scope, reasons: reasons.list, reasonsOmitted: reasons.omitted },
    blockers: blockers.list,
    steps: (payload.steps ?? []).map((step) => {
      const stepFiles = cut(step.worker?.files, keepFiles);
      const stepReasons = cut(step.scope?.reasons, keepReasons);
      return {
        ...step,
        ...step.worker ? { worker: { ...step.worker, files: stepFiles.list, filesOmitted: stepFiles.omitted } } : {},
        ...step.scope ? { scope: { ...step.scope, reasons: stepReasons.list } } : {}
      };
    })
  };
}
function stripStepText(step) {
  const out = { ...step };
  if (out.worker) out.worker = { ...out.worker, content: "" };
  if (out.verifier) out.verifier = { ...out.verifier, content: "" };
  if (out.tests) out.tests = { ...out.tests, output: "" };
  return out;
}
async function runOrchestration(spec) {
  const options = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec : null;
  if (options === null) {
    return failure({
      status: "invalid",
      error: `\uC778\uC790\uB294 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4 \u2014 ${spec === null ? "null" : Array.isArray(spec) ? "array" : typeof spec} \uB97C \uBC1B\uC558\uC2B5\uB2C8\uB2E4.`,
      recovery: "{ task, projectPath } \uB97C \uB2F4\uC740 \uAC1D\uCCB4\uB85C \uB2E4\uC2DC \uBD80\uB974\uC138\uC694."
    });
  }
  try {
    return await orchestrate(options);
  } catch (error2) {
    return failure({
      status: "failed",
      error: `\uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uC158\uC774 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uB85C \uBA48\uCDC4\uC2B5\uB2C8\uB2E4: ${safeText(error2)}`,
      recovery: "\uC11C\uBC84 \uB85C\uADF8\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uB0A8\uC544 \uC788\uC73C\uBA74 \uC0C1\uD0DC \uB8E8\uD2B8\uC758 worktrees/ \uB97C \uD655\uC778\uD558\uC138\uC694."
    });
  }
}
async function orchestrate(options) {
  const deps = options.deps && typeof options.deps === "object" ? options.deps : {};
  const task = options.task;
  if (typeof task !== "string" || task.trim() === "") {
    return failure({
      status: "invalid",
      error: "task \uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.",
      recovery: "\uBB34\uC5C7\uC744 \uD574\uC57C \uD558\uB294\uC9C0 \uD55C \uBB38\uC7A5 \uC774\uC0C1\uC73C\uB85C \uC801\uC5B4 \uC8FC\uC138\uC694."
    });
  }
  const projectPath = options.projectPath;
  if (typeof projectPath !== "string" || projectPath === "" || !isAbsolute13(projectPath)) {
    return failure({
      status: "invalid",
      error: `projectPath \uAC00 \uC808\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D9\uB2C8\uB2E4: ${show(projectPath)}`,
      recovery: "\uB300\uC0C1 git \uC800\uC7A5\uC18C\uC758 \uC808\uB300 \uACBD\uB85C\uB97C \uC8FC\uC138\uC694. \uC0C1\uB300 \uACBD\uB85C\uB294 \uC774 \uC11C\uBC84\uC758 cwd \uAE30\uC900\uC73C\uB85C \uD480\uB9BD\uB2C8\uB2E4."
    });
  }
  const isolation = options.isolation ?? "worktree";
  if (isolation !== "worktree") {
    return failure({
      status: "invalid",
      error: `isolation \uAC12\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4: ${show(isolation)}`,
      recovery: "isolation \uC740 'worktree' \uBFD0\uC785\uB2C8\uB2E4. \uC2E4\uCE21 \uACB0\uACFC \uBCA4\uB354 CLI \uC758 \uB3C4\uAD6C \uAD8C\uD55C \uD50C\uB798\uADF8\uB85C\uB294 \uB378\uB9AC\uAC8C\uC774\uD2B8\uC758 \uC178\uC744 \uC81C\uD55C\uD560 \uC218 \uC5C6\uC5B4, \uC2E4\uC81C\uB85C \uC131\uB9BD\uD558\uB294 \uACA9\uB9AC\uAC00 \uC77C\uD68C\uC6A9 \uC6CC\uD06C\uD2B8\uB9AC\uBFD0\uC785\uB2C8\uB2E4."
    });
  }
  const budget = options.budget ?? 1;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) {
    return failure({
      status: "invalid",
      error: `budget \uC740 1 \uC774\uC0C1 ${MAX_BUDGET} \uC774\uD558\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4: ${show(budget)}`,
      recovery: `\uC2A4\uD15D \uC218\uB97C 1~${MAX_BUDGET} \uC0AC\uC774\uC758 \uC815\uC218\uB85C \uC8FC\uC138\uC694.`
    });
  }
  const waitMs = options.waitMs ?? 0;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    return failure({
      status: "invalid",
      error: `waitMs \uB294 0 \uC774\uC0C1\uC758 \uC720\uD55C\uD55C \uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4: ${show(waitMs)}`,
      recovery: `\uBC00\uB9AC\uCD08 \uB2E8\uC704 \uC0C1\uD55C\uC744 \uC8FC\uC138\uC694. 0 \uC740 "\uD638\uCD9C\uC790\uAC00 \uC0C1\uD55C\uC744 \uC815\uD558\uC9C0 \uC54A\uB294\uB2E4" \uC774\uACE0, \uADF8\uB54C\uB3C4 \uC5D4\uC9C4 \uC790\uCCB4 \uC0C1\uD55C(${MAX_WAIT_MS}ms)\uC774 \uAC78\uB9BD\uB2C8\uB2E4.`
    });
  }
  const providers = Array.isArray(deps.providers) ? deps.providers : listProviders();
  const ids = providers.map((p) => p?.id).filter((id) => typeof id === "string" && id !== "");
  if (providers.length === 0) {
    return failure({
      status: "blocked",
      error: "\uC4F8 \uC218 \uC788\uB294 \uD504\uB85C\uBC14\uC774\uB354\uAC00 \uD558\uB098\uB3C4 \uC5C6\uC2B5\uB2C8\uB2E4.",
      recovery: "\uD504\uB85C\uBC14\uC774\uB354 \uBAA9\uB85D\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uC8FC\uC785\uD55C \uBAA9\uB85D\uC744 \uD655\uC778\uD558\uC138\uC694."
    });
  }
  const rawDecisions = options.decisions !== null && typeof options.decisions === "object" ? options.decisions : {};
  const callerArm = (axis) => {
    try {
      const value = rawDecisions[axis];
      return typeof value === "string" ? value : void 0;
    } catch {
      return void 0;
    }
  };
  const decisions = {};
  for (const axis of Object.keys(AXES)) {
    const arm = callerArm(axis);
    if (arm !== void 0) decisions[axis] = arm;
  }
  const sources = {};
  for (const axis of Object.keys(decisions)) sources[axis] = "caller";
  const pick2 = (wanted, fallback) => {
    if (wanted === void 0 || wanted === null) return { provider: fallback };
    const found = providers.find((p) => p?.id === wanted);
    return found ? { provider: found } : { unknown: wanted };
  };
  const placeRoles = (placement) => {
    const roles = assignRoles(providers, Object.create(decisions, { placement: { value: placement, enumerable: true } }));
    return {
      planner: pick2(options.planner, roles.planner),
      worker: pick2(options.worker, roles.worker),
      verifier: pick2(options.verifier, roles.verifier)
    };
  };
  let basePlacement = decisions.placement;
  let chosen = placeRoles(basePlacement);
  for (const [role, result] of Object.entries(chosen)) {
    if (result.unknown !== void 0) {
      return failure({
        status: "invalid",
        error: `\uBAA8\uB974\uB294 \uD504\uB85C\uBC14\uC774\uB354 id \uC785\uB2C8\uB2E4 (${role}): ${show(result.unknown)}`,
        recovery: `\uC4F8 \uC218 \uC788\uB294 \uD504\uB85C\uBC14\uC774\uB354: ${ids.join(", ")}`
      });
    }
  }
  const stateRoot2 = typeof deps.stateRoot === "string" && deps.stateRoot !== "" ? deps.stateRoot : resolveStateRoot();
  const runId = typeof deps.runId === "string" && RUN_ID_PATTERN2.test(deps.runId) ? deps.runId : makeRunId();
  const inspectRepo2 = deps.inspectRepo ?? inspectRepo;
  const createWorktree2 = deps.createWorktree ?? createWorktree;
  const snapshotStep2 = deps.snapshotStep ?? snapshotStep;
  const collectPatch2 = deps.collectPatch ?? collectPatch;
  const removeWorktree2 = deps.removeWorktree ?? removeWorktree;
  const deriveTestCommand2 = deps.deriveTestCommand ?? deriveTestCommand;
  const runTests2 = deps.runTests ?? runTests;
  const inspectPatch2 = deps.inspectPatch ?? inspectPatch;
  const trackChild2 = deps.trackChild ?? trackChild;
  const trackWorktree2 = deps.trackWorktree ?? trackWorktree;
  const listIgnoredPaths2 = deps.listIgnoredPaths ?? listIgnoredPaths;
  const treeKill2 = deps.treeKill ?? treeKill;
  const readSettings2 = deps.readSettings ?? readSettings;
  const readPosteriors2 = deps.readPosteriors ?? readPosteriors;
  const updatePosterior2 = deps.updatePosterior ?? updatePosterior;
  const appendRun2 = deps.appendRun ?? appendRun;
  const commitLearningMutation2 = deps.commitLearningMutation ?? commitLearningMutation;
  const legacyLearningSeams = Object.hasOwn(deps, "updatePosterior") || Object.hasOwn(deps, "appendRun");
  const learningOperationOptions = deps.learningOperationOptions;
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const random = typeof deps.random === "function" ? deps.random : Math.random;
  const effectiveWaitMs = waitMs > 0 ? Math.min(waitMs, MAX_WAIT_MS) : MAX_WAIT_MS;
  const deadline = timeoutSignal(effectiveWaitMs);
  const aborted2 = () => deadline?.aborted === true;
  const hardStopGraceMs = Number.isFinite(deps.hardStopGraceMs) && deps.hardStopGraceMs > 0 ? deps.hardStopGraceMs : HARD_STOP_GRACE_MS;
  const raceHardStop = (work) => {
    if (deadline === void 0) return work;
    let timer = null;
    let arm = null;
    const guard = new Promise((resolve6) => {
      arm = () => {
        if (timer === null) timer = setTimeout(() => resolve6(HARD_STOP), hardStopGraceMs);
        timer?.unref?.();
      };
      if (deadline.aborted) arm();
      else deadline.addEventListener("abort", arm, { once: true });
    });
    return Promise.race([work, guard]).finally(() => {
      clearTimeout(timer);
      try {
        deadline.removeEventListener?.("abort", arm);
      } catch {
      }
    });
  };
  const liveChildren = /* @__PURE__ */ new Map();
  const killedPids = /* @__PURE__ */ new Set();
  const killTree = (pid) => {
    if (killedPids.has(pid)) return void 0;
    killedPids.add(pid);
    try {
      const killed = treeKill2(pid);
      if (killed && typeof killed.then === "function") return Promise.resolve(killed).catch(() => false);
      return Promise.resolve(killed);
    } catch {
      return Promise.resolve(false);
    }
  };
  const onDeadlineAbort = () => {
    for (const pid of liveChildren.keys()) killTree(pid);
  };
  const killLiveChildren = async () => {
    const pending = [];
    for (const pid of liveChildren.keys()) {
      const killed = killTree(pid);
      if (killed !== void 0) pending.push(killed);
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  };
  deadline?.addEventListener("abort", onDeadlineAbort, { once: true });
  const notices = [];
  const addNotice = (text) => {
    if (typeof text !== "string" || text === "") return;
    const one = clip(text, NOTICE_CHARS);
    if (!notices.includes(one)) notices.push(one);
  };
  const leadNotices = [];
  const addLeadNotice = (text) => {
    if (typeof text !== "string" || text === "") return;
    const one = clip(text, NOTICE_CHARS);
    if (!leadNotices.includes(one)) leadNotices.push(one);
  };
  const vendorCount = new Set(ids).size;
  const steps = [];
  let singleVendorSteps = 0;
  const crossCheckLines = () => {
    const startPlacement = crossCheckNotice(chosen.worker.provider, chosen.verifier.provider, vendorCount);
    if (steps.length === 0 || singleVendorSteps === steps.length) {
      return startPlacement === null ? [] : [clip(startPlacement, NOTICE_CHARS)];
    }
    if (singleVendorSteps === 0) return [];
    return [
      clip(
        `${steps.length} \uC2A4\uD15D \uC911 ${singleVendorSteps} \uC2A4\uD15D\uC774 \uAD50\uCC28\uAC80\uC99D \uC5C6\uC774 \uD55C \uBCA4\uB354\uB85C \uB3CC\uC558\uC2B5\uB2C8\uB2E4 \u2014 \uADF8 \uC2A4\uD15D\uC740 \uC6CC\uCEE4\uC640 \uBCA0\uB9AC\uD30C\uC774\uC5B4\uAC00 \uAC19\uC740 \uBCA4\uB354\uB85C \uBC30\uCE58\uB410\uC2B5\uB2C8\uB2E4. \uC2A4\uD15D\uB9C8\uB2E4 \uBC30\uCE58\uAC00 \uB2EC\uB77C\uC84C\uC2B5\uB2C8\uB2E4 \u2014 \uC5B4\uB290 \uC2A4\uD15D\uC774 \uADF8\uB7AC\uB294\uC9C0\uB294 content \uC758 steps[].worker.provider\xB7verifier.provider \uB85C \uD655\uC778\uD558\uC138\uC694 (\uB04A\uAE34 \uC2A4\uD15D\uC740 verifier \uAE30\uB85D\uC774 \uC5C6\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4).`,
        NOTICE_CHARS
      )
    ];
  };
  const seal = (envelope, stopReason) => {
    const notice = joinNotices([...crossCheckLines(), ...leadNotices, ...notices]);
    return {
      ...envelope,
      runId,
      // status 만 보는 통합 패턴이 "통과"·"실패"·"못 돌림"·"정의 위조" 를 구분할 수 있어야 한다.
      ...stopReason !== void 0 ? { stopReason } : {},
      ...notice !== void 0 ? { notice } : {}
    };
  };
  const progress = typeof options.onProgress === "function" ? options.onProgress : null;
  const emit = (event) => {
    if (progress === null) return;
    try {
      progress(event);
    } catch {
    }
  };
  const phaseStart = (phase2, step) => emit({ phase: phase2, step, runId, event: { type: "phase", phase: phase2 } });
  const hardStopNotice = (label) => `${label} \uB2E8\uACC4\uAC00 \uB370\uB4DC\uB77C\uC778 \uB4A4 ${hardStopGraceMs}ms \uC548\uC5D0 \uB05D\uB098\uC9C0 \uC54A\uC544 \uAE30\uB2E4\uB9AC\uC9C0 \uC54A\uACE0 \uB098\uC654\uC2B5\uB2C8\uB2E4 \u2014 \uADF8 \uB2E8\uACC4\uC758 \uD504\uB85C\uC138\uC2A4\uAC00 \uC6CC\uD06C\uD2B8\uB9AC \uC548\uC5D0 \uB0A8\uC544 \uC788\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`;
  const stage = async (label, call) => {
    const result = await raceHardStop((async () => call())());
    if (result !== HARD_STOP) return result;
    addNotice(hardStopNotice(label));
    return {
      blocked: true,
      error: `${label} \uB2E8\uACC4\uAC00 \uB370\uB4DC\uB77C\uC778 \uB4A4\uC5D0\uB3C4 \uB05D\uB098\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.`,
      recovery: "wait_ms \uB97C \uB298\uB9AC\uAC70\uB098 \uB300\uC0C1 \uC800\uC7A5\uC18C\uC758 \uD06C\uAE30\xB7\uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694."
    };
  };
  let runStateRoot = stateRoot2;
  let worktreePath = null;
  const register = (child) => {
    try {
      const pid = child?.pid;
      if (Number.isInteger(pid) && pid > 0) {
        liveChildren.set(pid, child);
        try {
          child.on?.("exit", () => liveChildren.delete(pid));
        } catch {
        }
      }
      const tracked = trackChild2({ stateRoot: runStateRoot, child, runId, worktree: worktreePath });
      if (tracked && typeof tracked.catch === "function") tracked.catch(() => {
      });
    } catch {
    }
  };
  const callProvider = async ({ provider, role, phase: phase2, step, workspace, instruction, tools, tier }) => {
    phaseStart(phase2, step);
    const selection = resolveTier(tier.settings, provider.id, tier.name);
    try {
      const result = await raceHardStop(provider.run({
        role,
        model: selection.model,
        effort: selection.effort,
        instruction,
        workspace,
        tools,
        // 실측으로 강제되지 않는 채널이지만, 넘기는 것이 그 벤더의 기본값보다는 좁다.
        allowedTools: tools,
        signal: deadline,
        onProgress: (event) => emit({ phase: phase2, step, runId, event }),
        onSpawn: register,
        runId
      }));
      if (result === HARD_STOP) {
        addNotice(hardStopNotice(phase2));
        return { content: "", truncated: true, notice: null, hardStopped: true, error: `${phase2} \uB2E8\uACC4\uAC00 \uB370\uB4DC\uB77C\uC778 \uB4A4\uC5D0\uB3C4 \uB05D\uB098\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.` };
      }
      if (result === null || typeof result !== "object") {
        return { content: "", truncated: true, notice: null, error: "\uD504\uB85C\uBC14\uC774\uB354\uAC00 \uC54C \uC218 \uC5C6\uB294 \uC751\uB2F5\uC744 \uB0C8\uC2B5\uB2C8\uB2E4." };
      }
      return result;
    } catch (error2) {
      return {
        content: "",
        truncated: true,
        notice: null,
        error: `\uD504\uB85C\uBC14\uC774\uB354\uAC00 \uB358\uC84C\uC2B5\uB2C8\uB2E4: ${safeText(error2)}`,
        recovery: "\uD574\uB2F9 \uBCA4\uB354 CLI \uC758 \uC124\uCE58 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694."
      };
    }
  };
  phaseStart("inspect", 0);
  const inspected = await stage("\uC800\uC7A5\uC18C \uC0AC\uC804 \uC810\uAC80", () => inspectRepo2(projectPath));
  if (isBlocked(inspected)) {
    return seal(
      failure({
        status: "blocked",
        error: inspected.error,
        recovery: inspected.recovery ?? GENERIC_RECOVERY6,
        ...Array.isArray(inspected.choices) ? { choices: inspected.choices } : {}
      }),
      "blocked"
    );
  }
  phaseStart("worktree", 0);
  const worktree = await createWorktree2({ projectPath, stateRoot: stateRoot2, runId });
  if (isBlocked(worktree)) {
    return seal(
      failure({ status: "blocked", error: worktree.error, recovery: worktree.recovery ?? GENERIC_RECOVERY6 }),
      "blocked"
    );
  }
  worktreePath = worktree.path;
  runStateRoot = worktree.stateRoot;
  const scratch = await sweepScratch(runStateRoot, nowMs);
  if (scratch.removed > 0) {
    addNotice(
      `\uC0C1\uD0DC \uB8E8\uD2B8\uC758 scratch \uC5D0\uC11C \uC624\uB798\uB41C \uC794\uC7AC ${scratch.removed}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4 \u2014 \uAC15\uC81C \uC885\uB8CC\uB41C \uC2E4\uD589\uC774 \uB0A8\uAE34 \uC784\uC2DC \uC778\uB371\uC2A4\xB7state \uD328\uCE58\uC774\uACE0, \uAC70\uAE30\uC5D0\uB294 \uC0AC\uC6A9\uC790\uC758 \uBBF8\uCEE4\uBC0B \uB0B4\uC6A9\uC774 \uD3C9\uBB38\uC73C\uB85C \uB4E4\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.`
    );
  }
  const sweptPatches = await sweepPatches(runStateRoot, nowMs);
  if (sweptPatches.removed > 0) {
    addNotice(
      `\uC0C1\uD0DC \uB8E8\uD2B8\uC758 patches \uC5D0\uC11C 30\uC77C\uC774 \uC9C0\uB09C \uD328\uCE58 ${sweptPatches.removed}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4 \u2014 \uADF8 \uD30C\uC77C\uC5D0\uB294 \uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uB9CC\uB4E0 \uC18C\uC2A4\uAC00 \uD3C9\uBB38\uC73C\uB85C \uB4E4\uC5B4 \uC788\uACE0, \uBCF4\uC874 \uC815\uCC45 \uC5C6\uC774\uB294 \uBB34\uD55C\uD788 \uC313\uC785\uB2C8\uB2E4.`
    );
  }
  const journalSize = await journalBytes(runStateRoot);
  if (typeof journalSize === "number" && journalSize > JOURNAL_LARGE_BYTES) {
    addNotice(
      `\uC2E4\uD589 \uC800\uB110\uC774 \uCEE4\uC84C\uC2B5\uB2C8\uB2E4: ${Math.round(journalSize / (1024 * 1024))}MB (\uC784\uACC4 ${JOURNAL_LARGE_BYTES / (1024 * 1024)}MB). \uC774 \uD30C\uC77C\uC740 \uC790\uB3D9\uC73C\uB85C \uC798\uB9AC\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4 \u2014 \uC798\uB77C\uB0B4\uBA74 \uC0AC\uD6C4\uBD84\uD3EC\uC5D0 \uB0A8\uC740 \uAE30\uC5EC\uC640 \uC5B4\uAE0B\uB098\uAE30 \uB54C\uBB38\uC785\uB2C8\uB2E4. \uD544\uC694\uD558\uBA74 \uC0AC\uC6A9\uC790\uAC00 \uC9C1\uC811 \uBCF4\uAD00\uD558\uACE0 \uBE44\uC6B0\uC138\uC694.`
    );
  }
  const reclaimed = await reclaimOrphanRegistrations({
    run: deps.runGit ?? runGit,
    projectPath: worktree.projectPath,
    stateRoot: runStateRoot
  });
  if (reclaimed.reclaimed > 0) {
    addNotice(
      `\uC55E\uC120 \uC2E4\uD589\uC774 \uB0A8\uAE34 \uC8FD\uC740 \uC6CC\uD06C\uD2B8\uB9AC \uB4F1\uB85D ${reclaimed.reclaimed}\uAC1C\uB97C \uD68C\uC218\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uB9AC\uD37C\uB294 \uB514\uB809\uD130\uB9AC\uB9CC \uC9C0\uC6B0\uACE0 \uB4F1\uB85D \uD574\uC81C\uB97C \uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`
    );
  }
  const planDir = join14(runStateRoot, "plans", runId);
  let keepWorktree = false;
  let released = false;
  let scopeConfidence = null;
  let scopeRecovery = null;
  let scopeFlagged = false;
  let scopeReasons = [];
  let patchEmpty = null;
  const noteScope = (result) => {
    scopeFlagged = true;
    scopeConfidence = result.confidence ?? "disputed";
    scopeRecovery = result.recovery ?? GENERIC_RECOVERY6;
    scopeReasons = Array.isArray(result.reasons) ? result.reasons : [];
  };
  const release = async () => {
    if (released) return;
    released = true;
    await killLiveChildren();
    if (keepWorktree) return;
    const removal = await stage("\uC6CC\uD06C\uD2B8\uB9AC \uD68C\uC218", () => removeWorktree2(worktree)).catch((error2) => ({
      blocked: true,
      error: safeText(error2)
    }));
    if (isBlocked(removal) || removal?.removed === false || removal?.unregistered === false) {
      addNotice(
        `\uC6CC\uD06C\uD2B8\uB9AC\uB97C \uC644\uC804\uD788 \uD68C\uC218\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${worktree.path} \u2014 \uB0A8\uC740 \uD504\uB85C\uC138\uC2A4\uAC00 \uD30C\uC77C\uC744 \uC950\uACE0 \uC788\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`
      );
      await Promise.resolve(
        trackWorktree2({ stateRoot: runStateRoot, runId, worktree: worktree.path })
      ).catch(() => {
      });
    }
  };
  let learning = null;
  let learningRecorded = false;
  const reasonOf = (result) => safeText(result?.reason ?? result?.error ?? "\uC0AC\uC720\uB97C \uBC1B\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
  const learningView = () => learning === null ? void 0 : {
    taskClass: learning.taskClass,
    decisions: learning.decisions,
    sources: learning.sources,
    applied: learning.applied
  };
  const gradeOfRun = ({ stopReason }) => {
    const last = steps.at(-1)?.tests;
    if (stopReason === "verified") {
      if (last?.confidence !== "verified") return null;
      const verifierTampered = steps.some((record2) => record2.verifier?.touchedSources === true);
      if (verifierTampered) return null;
      return patchEmpty === true || scopeConfidence !== null ? null : "success";
    }
    if (stopReason === "test-definition-changed") return "failure";
    if (stopReason !== "budget") return null;
    if (last?.ran !== true) return null;
    if (last.confidence !== "verified") return null;
    return last.passed === false ? "failure" : null;
  };
  const axesFor = (stopReason) => learning.learnable.filter((axis) => stopReason !== "test-definition-changed" || axis === "placement");
  const recordLearning = async (stopReason) => {
    if (learning === null || learningRecorded) return;
    learningRecorded = true;
    try {
      const grade = gradeOfRun({ stopReason });
      const deltas = gradeToDeltas(grade);
      const rewardable = axesFor(stopReason);
      const wanted = deltas === null ? [] : rewardable;
      if (deltas !== null && wanted.length === 0) addNotice(learning.skipNotice);
      if (!legacyLearningSeams) {
        const applied2 = deltas === null ? [] : wanted;
        const updates = deltas === null ? [] : wanted.map((axis) => ({
          cellKey: cellKeyOf(learning.taskClass, axis),
          arm: learning.decisions[axis],
          ...deltas
        }));
        const stored = await stage(
          "\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC\xB7\uC2E4\uD589 \uC800\uB110 \uAE30\uB85D",
          () => commitLearningMutation2(
            runStateRoot,
            {
              updates,
              journal: {
                runId,
                taskClass: learning.taskClass,
                decisions: learning.decisions,
                outcome: { grade, stopReason: stopReason ?? null },
                appliedGrade: applied2.length > 0 ? grade : null,
                appliedAxes: applied2,
                rewardableAxes: rewardable
              }
            },
            learningOperationOptions
          )
        );
        if (stored?.ok !== true) {
          learning.applied = { grade: null, axes: [] };
          if (stored?.pending === false) {
            const fallback = await stage(
              "\uD559\uC2B5 \uC2E4\uD589 \uC800\uB110 \uAE30\uB85D",
              () => commitLearningMutation2(runStateRoot, {
                updates: [],
                journal: {
                  runId,
                  taskClass: learning.taskClass,
                  decisions: learning.decisions,
                  outcome: { grade, stopReason: stopReason ?? null },
                  appliedGrade: null,
                  appliedAxes: [],
                  rewardableAxes: rewardable
                }
              })
            );
            if (fallback?.ok === true) {
              addLeadNotice(`\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uAC31\uC2E0\uD558\uC9C0 \uBABB\uD574 \uC2E4\uD589 \uAE30\uB85D\uB9CC \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${reasonOf(stored)}`);
              if (typeof fallback.notice === "string" && fallback.notice !== "") {
                addLeadNotice(`\uC2E4\uD589 \uAE30\uB85D \uC54C\uB9BC: ${fallback.notice}`);
              }
              return;
            }
            addLeadNotice(`\uD559\uC2B5 \uAC31\uC2E0\uACFC \uC2E4\uD589 \uAE30\uB85D\uC744 \uB0A8\uAE30\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${reasonOf(fallback)}`);
            return;
          }
          addLeadNotice(`\uD559\uC2B5 \uAC31\uC2E0\uC744 \uBABB \uD588\uC2B5\uB2C8\uB2E4: ${reasonOf(stored)} (\uBCF4\uB958 \uC911\uC778 \uC791\uC5C5\uC740 \uB2E4\uC74C \uC77D\uAE30 \uB610\uB294 \uC7AC\uC2DC\uB3C4\uC5D0\uC11C \uBCF5\uAD6C\uB429\uB2C8\uB2E4.)`);
          return;
        }
        learning.applied = { grade: applied2.length > 0 ? grade : null, axes: applied2 };
        if (typeof stored.notice === "string" && stored.notice !== "") addLeadNotice(`\uD559\uC2B5 \uAC31\uC2E0 \uC54C\uB9BC: ${stored.notice}`);
        return;
      }
      const applied = [];
      for (const axis of wanted) {
        const got = await stage(
          "\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC \uAC31\uC2E0",
          () => updatePosterior2(runStateRoot, {
            cellKey: cellKeyOf(learning.taskClass, axis),
            arm: learning.decisions[axis],
            ...deltas
          })
        );
        if (got?.ok !== true) {
          addLeadNotice(`\uD559\uC2B5 \uAC31\uC2E0\uC744 \uBABB \uD588\uC2B5\uB2C8\uB2E4(${axis}): ${reasonOf(got)}`);
          continue;
        }
        if (typeof got.notice === "string" && got.notice !== "") addLeadNotice(`\uD559\uC2B5 \uAC31\uC2E0 \uC54C\uB9BC: ${got.notice}`);
        applied.push(axis);
      }
      learning.applied = { grade: applied.length > 0 ? grade : null, axes: applied };
      const journaled = await stage(
        "\uC2E4\uD589 \uC800\uB110 \uAE30\uB85D",
        () => appendRun2(runStateRoot, {
          runId,
          taskClass: learning.taskClass,
          decisions: learning.decisions,
          outcome: { grade, stopReason: stopReason ?? null },
          appliedGrade: learning.applied.grade,
          appliedAxes: applied,
          rewardableAxes: rewardable
        })
      );
      if (journaled?.ok !== true) addLeadNotice(`\uC2E4\uD589 \uAE30\uB85D\uC744 \uB0A8\uAE30\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${reasonOf(journaled)}`);
      else if (typeof journaled.notice === "string" && journaled.notice !== "") {
        addLeadNotice(`\uC2E4\uD589 \uAE30\uB85D \uC54C\uB9BC: ${journaled.notice}`);
      }
    } catch (error2) {
      addLeadNotice(`\uD559\uC2B5\uC744 \uAE30\uB85D\uD558\uB2E4 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4: ${safeText(error2)}`);
    }
  };
  const sealFailure = async ({ status, error: error2, recovery, stopReason, ...rest }) => {
    await recordLearning(stopReason);
    await release();
    return seal(
      failure({
        status,
        error: error2,
        recovery: `${scopeRecovery !== null ? `${scopeRecovery} ` : ""}${recovery}`,
        confidence: scopeConfidence ?? "unverified",
        ...rest
      }),
      stopReason
    );
  };
  try {
    const derived = await stage("\uD14C\uC2A4\uD2B8 \uBA85\uB839 \uC720\uB3C4", () => deriveTestCommand2(projectPath));
    const testPlan = isBlocked(derived) ? null : derived ?? null;
    if (testPlan !== null && typeof testPlan.resolveError === "string" && testPlan.resolveError !== "") {
      addNotice(`\uD14C\uC2A4\uD2B8 \uB3C4\uAD6C\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${testPlan.resolveError}`);
    }
    const taskClass = classifyTask({ task, testSource: testPlan?.source ?? null });
    const posteriors = await stage("\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC \uC77D\uAE30", () => readPosteriors2(runStateRoot));
    if (posteriors?.ok !== true) {
      addLeadNotice(`\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC77D\uC9C0 \uBABB\uD574 \uC774\uBC88 \uC2E4\uD589\uC740 \uAE30\uBCF8\uAC12\uC73C\uB85C \uB3D5\uB2C8\uB2E4: ${reasonOf(posteriors)}`);
    }
    const advice = decide({
      cells: posteriors?.ok === true ? posteriors.cells : {},
      taskClass,
      // ① `orch_run` 의 `allow_single` 이 여기까지 온다. 안 넘기면 `allow_single: true` 가
      //    조용한 무연산이 된다(태스크 6 이 배선했는데 읽는 곳이 0곳이었다).
      allowed: { single: options.allowSingle === true },
      random
    });
    for (const axis of Object.keys(AXES)) {
      if (decisions[axis] !== void 0) continue;
      decisions[axis] = advice.decisions[axis];
      sources[axis] = advice.sources[axis];
    }
    basePlacement = decisions.placement;
    chosen = placeRoles(basePlacement);
    const roleOverrides = [options.planner, options.worker, options.verifier].filter(
      (id) => id !== void 0 && id !== null
    );
    const anyRolePinned = roleOverrides.length > 0;
    const rewritePinned = options.worker !== void 0 && options.worker !== null && options.verifier !== void 0 && options.verifier !== null;
    const soloVendor = vendorCount <= 1;
    const skipReasons = [];
    if (soloVendor) skipReasons.push("\uBCA4\uB354\uAC00 \uD558\uB098\uBFD0\uC774\uB77C \uBC30\uCE58\xB7\uAD50\uCC28\uAC80\uC99D\xB7\uC7AC\uC791\uC131 \uCD95\uC774 \uBB34\uC5F0\uC0B0\uC785\uB2C8\uB2E4");
    if (rewritePinned) skipReasons.push("\uC6CC\uCEE4\xB7\uBCA0\uB9AC\uD30C\uC774\uC5B4\uB97C \uB458 \uB2E4 \uC9C0\uC815\uD574 \uC7AC\uC791\uC131 \uB4A4\uC9D1\uAE30\uAC00 \uBB34\uC5F0\uC0B0\uC785\uB2C8\uB2E4");
    else if (anyRolePinned) skipReasons.push("\uC5ED\uD560 \uC9C0\uC815\uC774 \uACB0\uC815\uC744 \uC774\uACA8 \uBC30\uCE58\xB7\uAD50\uCC28\uAC80\uC99D \uCD95\uC758 \uAE30\uB85D\uACFC \uC2E4\uC81C\uAC00 \uAC08\uB9BD\uB2C8\uB2E4");
    const learnable = Object.keys(AXES).filter((axis) => {
      if (axis === "tier") return true;
      if (soloVendor) return false;
      if (axis === "rewrite") return !rewritePinned;
      if (anyRolePinned) return false;
      return true;
    });
    learning = {
      taskClass,
      decisions,
      sources,
      learnable,
      applied: null,
      skipNotice: `\uC774 \uC2E4\uD589\uC758 \uACB0\uACFC\uB97C \uD559\uC2B5\uC5D0 \uBC18\uC601\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4 \u2014 ${skipReasons.join(" / ") || "\uBC18\uC601\uD560 \uCD95\uC774 \uC5C6\uC2B5\uB2C8\uB2E4"}.`
    };
    await rm8(planDir, { recursive: true, force: true }).catch(() => {
    });
    await mkdir6(planDir, { recursive: true });
    const settings = await readSettings2(runStateRoot).catch(() => ({}));
    const tier = {
      settings,
      name: AXES.tier.arms.includes(decisions.tier) ? decisions.tier : AXES.tier.default
    };
    const planner = await callProvider({
      provider: chosen.planner.provider,
      role: PLANNER_ROLE,
      phase: "planner",
      step: 0,
      workspace: planDir,
      instruction: plannerInstruction({ task, testPlan, evidence: advice.evidence }),
      // 읽기 전용 역할은 프로바이더가 도구를 전부 끈다. 집합을 넘기지 않는다.
      tools: void 0,
      tier
    });
    addNotice(planner.notice);
    const plan = typeof planner.content === "string" && planner.content !== "" ? planner.content : task;
    if (!await rm8(planDir, { recursive: true, force: true }).then(() => true, () => false)) {
      addNotice(`\uC77C\uD68C\uC6A9 \uACC4\uD68D \uB514\uB809\uD130\uB9AC\uB97C \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${planDir}`);
    }
    const blockers = [];
    let stopReason = "budget";
    let unverified = testPlan === null;
    let feedback = null;
    const rewriteArm = decisions.rewrite === "wide" ? "wide" : "deep";
    let placement = basePlacement;
    let previousRoles = null;
    let rewriteFlips = 0;
    for (let step = 1; step <= budget; step += 1) {
      if (aborted2()) {
        stopReason = "deadline";
        break;
      }
      const record2 = { step };
      steps.push(record2);
      const active = placeRoles(placement);
      if (previousRoles !== null && (previousRoles.worker.provider !== active.worker.provider || previousRoles.verifier.provider !== active.verifier.provider)) {
        rewriteFlips += 1;
      }
      previousRoles = active;
      if (typeof active.worker.provider?.id === "string" && active.worker.provider.id === active.verifier.provider?.id) {
        singleVendorSteps += 1;
      }
      const worker = await callProvider({
        provider: active.worker.provider,
        role: "worker",
        phase: "worker",
        step,
        workspace: worktree.path,
        instruction: workerInstruction({ task, plan, step, budget, feedback }),
        tools: [...WORKER_TOOLS],
        tier
      });
      addNotice(worker.notice);
      record2.worker = {
        provider: active.worker.provider.id,
        truncated: worker.truncated === true,
        content: clip(worker.content, EXCERPT_CHARS)
      };
      if (typeof worker.error === "string" && worker.error !== "") {
        record2.worker.error = worker.error;
        unverified = true;
      }
      const afterWorker = await stage("\uC6CC\uCEE4 \uB4A4 \uC2A4\uB0C5\uC0F7", () => snapshotStep2(worktree, `bom-orch step ${step} worker`));
      if (isBlocked(afterWorker)) {
        blockers.push({ where: "snapshot(worker)", error: afterWorker.error, recovery: afterWorker.recovery });
        stopReason = "blocked";
        break;
      }
      record2.worker.files = afterWorker.files;
      const ignoredNow = await stage("\uBB34\uC2DC\uB41C \uACBD\uB85C \uC870\uD68C", () => listIgnoredPaths2(worktree));
      const ignoredList = Array.isArray(ignoredNow) ? ignoredNow : [];
      if (!Array.isArray(ignoredNow)) {
        addNotice("\uC6CC\uD06C\uD2B8\uB9AC\uC758 \uBB34\uC2DC\uB41C \uACBD\uB85C \uBAA9\uB85D\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uBB34\uC2DC \uADDC\uCE59 \uB4A4\uC5D0 \uC228\uC740 \uC4F0\uAE30\uB97C \uBCF4\uC9C0 \uBABB\uD569\uB2C8\uB2E4.");
      }
      const scopeFiles = [...afterWorker.files, ...ignoredList.filter((path) => !afterWorker.files.includes(path))];
      const stepScope = await stage("\uC2A4\uD15D \uC2A4\uCF54\uD504 \uAC80\uC0AC", () => inspectPatch2({ files: scopeFiles, worktree: worktree.path, baseline: worktree.baseline }));
      if (isBlocked(stepScope)) {
        blockers.push({ where: "inspectPatch(step)", error: stepScope.error, recovery: stepScope.recovery });
        stopReason = "blocked";
        break;
      }
      record2.worker.ignoredPaths = ignoredList;
      record2.scope = { flagged: stepScope.flagged, reasons: stepScope.reasons.slice(0, MAX_REASONS_PER_STEP) };
      if (stepScope.flagged) {
        noteScope(stepScope);
        stopReason = "scope-flagged";
        break;
      }
      if (aborted2()) {
        stopReason = "deadline";
        break;
      }
      const tests = await runStepTests({
        testPlan,
        worktree,
        runId,
        deadline,
        register,
        runTests: runTests2,
        phaseStart,
        step,
        stage
      });
      record2.tests = tests.record;
      if (Array.isArray(tests.record?.notes) && tests.record.notes.includes(USER_PRIVILEGE_NOTE)) {
        addNotice(USER_PRIVILEGE_NOTE);
      }
      if (tests.definitionRejected) {
        stopReason = "test-definition-changed";
        unverified = true;
        break;
      }
      if (tests.blocked !== null) {
        blockers.push(tests.blocked);
        stopReason = "blocked";
        break;
      }
      if (tests.unverified) unverified = true;
      const afterTests = await stage("\uD14C\uC2A4\uD2B8 \uB4A4 \uC2A4\uB0C5\uC0F7", () => snapshotStep2(worktree, `bom-orch step ${step} tests`));
      if (isBlocked(afterTests)) {
        blockers.push({ where: "snapshot(tests)", error: afterTests.error, recovery: afterTests.recovery });
        stopReason = "blocked";
        break;
      }
      record2.tests.artifacts = afterTests.files;
      if (aborted2()) {
        stopReason = "deadline";
        break;
      }
      const verifier = await callProvider({
        provider: active.verifier.provider,
        role: "verifier",
        phase: "verifier",
        step,
        workspace: worktree.path,
        instruction: verifierInstruction({
          task,
          plan,
          files: afterWorker.files,
          tests: describeTests(record2.tests)
        }),
        tools: [...VERIFIER_TOOLS],
        tier
      });
      addNotice(verifier.notice);
      const afterVerifier = await stage("\uBCA0\uB9AC\uD30C\uC774\uC5B4 \uB4A4 \uC2A4\uB0C5\uC0F7", () => snapshotStep2(worktree, `bom-orch step ${step} verifier`));
      if (isBlocked(afterVerifier)) {
        blockers.push({ where: "snapshot(verifier)", error: afterVerifier.error, recovery: afterVerifier.recovery });
        stopReason = "blocked";
        break;
      }
      const changed = afterVerifier.changed === true;
      const ambiguous = record2.tests?.lingering === true || record2.tests?.hung === true;
      const touchedBy = changed ? ambiguous ? "unknown" : "verifier" : "none";
      record2.verifier = {
        provider: active.verifier.provider.id,
        truncated: verifier.truncated === true,
        touchedSources: changed && !ambiguous,
        touchedBy,
        touchedFiles: afterVerifier.files,
        confidence: changed ? "unverified" : "verified",
        content: clip(verifier.content, EXCERPT_CHARS)
      };
      let verifierOk = true;
      if (typeof verifier.error === "string" && verifier.error !== "") {
        record2.verifier.error = verifier.error;
        verifierOk = false;
        unverified = true;
      }
      if (changed) {
        verifierOk = false;
        unverified = true;
        const where = afterVerifier.files.length > 0 ? few(afterVerifier.files) : "\uACBD\uB85C \uBD88\uBA85";
        addNotice(
          ambiguous ? `\uBCA0\uB9AC\uD30C\uC774\uC5B4 \uB4A4\uC5D0 \uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4(${where}). \uB2E4\uB9CC \uC774 \uC2A4\uD15D\uC758 \uD14C\uC2A4\uD2B8\uAC00 \uB0A8\uC740 \uD504\uB85C\uC138\uC2A4\uB97C \uC2E0\uACE0\uD588\uC73C\uBBC0\uB85C \uB204\uAC00 \uC37C\uB294\uC9C0 \uD655\uC815\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uC2E0\uB8B0\uB3C4\uB9CC \uB0AE\uCDC4\uC2B5\uB2C8\uB2E4.` : `\uBCA0\uB9AC\uD30C\uC774\uC5B4\uAC00 \uC6CC\uD06C\uD2B8\uB9AC\uC758 \uC18C\uC2A4\uB97C \uACE0\uCCE4\uC2B5\uB2C8\uB2E4(${where}) \u2014 \uADF8 \uD310\uC815\uC740 \uC790\uAE30\uAC00 \uACE0\uCE5C \uCF54\uB4DC\uC5D0 \uB300\uD55C \uAC83\uC774\uB77C \uC2E0\uB8B0\uB3C4\uB97C \uB0AE\uCDC4\uC2B5\uB2C8\uB2E4.`
        );
      }
      feedback = [
        `\uD14C\uC2A4\uD2B8: ${describeTests(record2.tests)}`,
        `\uBCA0\uB9AC\uD30C\uC774\uC5B4: ${clip(verifier.content, EXCERPT_CHARS)}`
      ].join("\n");
      if (record2.tests.passed === true && verifierOk) {
        stopReason = "verified";
        break;
      }
      if (aborted2()) {
        stopReason = "deadline";
        break;
      }
      if (rewriteArm === "wide") placement = flipPlacement(placement);
    }
    if (stopReason === "budget" && aborted2()) stopReason = "deadline";
    if (stopReason !== "deadline" && aborted2()) {
      addNotice("\uBAA8\uB4E0 \uB2E8\uACC4\uAC00 \uB05D\uB09C \uB4A4 \uB4B7\uC815\uB9AC \uAD6C\uAC04\uC5D0\uC11C \uB370\uB4DC\uB77C\uC778\uC774 \uC9C0\uB0AC\uC2B5\uB2C8\uB2E4 \u2014 \uACB0\uACFC \uD310\uC815\uC740 \uB4A4\uC9D1\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    }
    const partialContent = (patchInfo) => renderContent({
      runId,
      stopReason,
      stepCount: steps.length,
      patch: patchInfo,
      scope: { flagged: scopeFlagged, reasons: scopeReasons, omitted: 0 },
      worktree: {
        // 경로는 **남겨 둔 경우에만** 싣는다. 회수한 디렉터리를 가리키면 사람은 없는 것을
        // 찾느라 시간을 쓴다.
        ...keepWorktree ? { path: worktree.path } : {},
        transplanted: worktree.transplanted,
        ignoredPaths: worktree.ignoredPaths,
        sharedRules: worktree.sharedRules
      },
      blockers,
      rewrite: { arm: rewriteArm, flips: rewriteFlips },
      // ★ 이 갈래들은 `recordLearning` 보다 **먼저** content 를 만든다. 그래서 `applied` 가
      //   아직 `null` 인데, 이 갈래의 `stopReason` 은 전부 `'blocked'`·`'failed'` 라 등급이
      //   `null` 이고 실제로 아무것도 반영되지 않는다 — `null` 이 사실이다.
      learning: learningView(),
      plan: { provider: chosen.planner.provider.id, content: clip(plan, EXCERPT_CHARS) },
      steps: steps.map((record2, index) => index === steps.length - 1 ? record2 : stripToExcerpt(record2))
    });
    phaseStart("patch", 0);
    const patch = await stage("\uCD5C\uC885 \uD328\uCE58 \uC218\uC9D1", () => collectPatch2(worktree));
    if (isBlocked(patch)) {
      keepWorktree = true;
      return await sealFailure({
        status: "blocked",
        error: patch.error,
        recovery: `${patch.recovery ?? GENERIC_RECOVERY6} \uB378\uB9AC\uAC8C\uC774\uD2B8\uC758 \uC791\uC5C5\uC744 \uC783\uC9C0 \uC54A\uC73C\uB824\uACE0 \uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${worktree.path} (\uD544\uC694 \uC5C6\uC73C\uBA74 \uB300\uC0C1 \uC800\uC7A5\uC18C\uC5D0\uC11C \`git worktree remove --force\` \uB85C \uC9C0\uC6B0\uC138\uC694).`,
        content: partialContent({ path: null, bytes: 0, empty: null, files: [], ignoredPaths: null, gitlinks: null }),
        worktree: worktree.path,
        stopReason: "blocked"
      });
    }
    const patchDir = join14(runStateRoot, "patches");
    await mkdir6(patchDir, { recursive: true });
    const patchPath = join14(patchDir, `${runId}.patch`);
    await writeFile4(patchPath, patch.patch);
    addNotice(
      `\uCD5C\uC885 \uD328\uCE58\uB97C ${patchPath} \uC5D0 \uB0A8\uACBC\uC2B5\uB2C8\uB2E4 \u2014 \uC774 \uB514\uB809\uD130\uB9AC\uB294 \uC2E4\uD589\uB9C8\uB2E4 \uC313\uC774\uACE0, 30\uC77C\uC774 \uC9C0\uB09C \uAC83\uC740 \uB2E4\uC74C \uC2E4\uD589\uC774\uB098 \uC11C\uBC84 \uBD80\uD305\uC774 \uC9C0\uC6C1\uB2C8\uB2E4. \uB354 \uC624\uB798 \uB450\uB824\uBA74 \uB2E4\uB978 \uACF3\uC73C\uB85C \uC62E\uAE30\uC138\uC694.`
    );
    patchEmpty = patch.empty === true;
    if (patch.empty) {
      unverified = true;
      addNotice(
        `\uCD5C\uC885 \uD328\uCE58\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uCEE4\uAC00 \uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uB0A8\uAE34 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBB34\uC2DC \uADDC\uCE59\uC5D0 \uAC78\uB9B0 \uACBD\uB85C(${few(patch.ignoredPaths)})\uC640 gitlink(${few(patch.gitlinks)}) \uC758 \uB0B4\uC6A9\uC740 \uD328\uCE58\uC5D0 \uC2E4\uB9AC\uC9C0 \uC54A\uC73C\uBBC0\uB85C, \uADF8 \uB458\uC774 \uBE44\uC5B4 \uC788\uC744 \uB54C\uB9CC "\uC131\uACFC 0" \uC73C\uB85C \uC77D\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`
      );
    }
    if (patch.ignoredPaths === null || patch.gitlinks === null) {
      addNotice("\uBB34\uC2DC\uB41C \uACBD\uB85C \uB610\uB294 gitlink \uBAA9\uB85D\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uD328\uCE58\uC5D0 \uC548 \uC2E4\uB9B0 \uBCC0\uACBD\uC774 \uC788\uB294\uC9C0 \uBAA8\uB985\uB2C8\uB2E4.");
    }
    phaseStart("scope", 0);
    const finalScope = await stage("\uCD5C\uC885 \uC2A4\uCF54\uD504 \uAC80\uC0AC", () => inspectPatch2({ files: patch.files, worktree: worktree.path, baseline: worktree.baseline }));
    if (isBlocked(finalScope)) {
      return await sealFailure({
        status: "blocked",
        error: finalScope.error,
        recovery: `${finalScope.recovery ?? GENERIC_RECOVERY6} \uD328\uCE58\uB294 \uD30C\uC77C\uB85C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${patchPath}`,
        content: partialContent({
          path: patchPath,
          bytes: patch.patch.length,
          empty: patch.empty,
          files: patch.files,
          ignoredPaths: patch.ignoredPaths,
          gitlinks: patch.gitlinks
        }),
        patchPath,
        stopReason: "blocked"
      });
    }
    if (finalScope.flagged) noteScope(finalScope);
    const lastTests = steps.at(-1)?.tests;
    if (lastTests?.passed !== true) unverified = true;
    const confidence = scopeConfidence !== null ? scopeConfidence : stopReason === "test-definition-changed" ? "disputed" : unverified ? "unverified" : "verified";
    await recordLearning(stopReason);
    const payload = {
      runId,
      stopReason,
      stepCount: steps.length,
      patch: {
        path: patchPath,
        bytes: patch.patch.length,
        empty: patch.empty,
        files: patch.files,
        ignoredPaths: patch.ignoredPaths,
        gitlinks: patch.gitlinks
      },
      // ★ 최종 검사의 판정만 싣지 않는다. 스텝 검사가 플래그해서 루프가 조기에 끊긴 실행은
      //   최종 검사가 통과하는 것이 정상인데(그 스텝의 변경이 최종 패치에 없을 수도 있다),
      //   그러면 봉투 최상위가 "스코프 문제 없음" 이라고 말하면서 confidence 만 disputed 가
      //   된다. `scope` 는 이 실행의 누적 판정이다.
      scope: {
        flagged: scopeFlagged,
        reasons: scopeFlagged ? scopeReasons : finalScope.reasons,
        omitted: finalScope.omitted
      },
      worktree: {
        transplanted: worktree.transplanted,
        ignoredPaths: worktree.ignoredPaths,
        sharedRules: worktree.sharedRules
      },
      blockers,
      // ★ §7.2 결정③ 이 **실제로** 무엇을 했는가. `arm` 은 이 실행이 돈 팔이고 `flips` 는
      //   뒤집기가 배치를 실제로 바꾼 횟수다 — `arm:'wide'` 인데 `flips:0` 이면 그 축은 이
      //   실행에서 무연산이었다(벤더 하나 · 역할 전부 지정 · budget 1 · 첫 스텝에서 종료).
      //   태스크 8 이 그런 실행의 `rewrite` 셀을 갱신할지 여기 값을 보고 정한다.
      rewrite: { arm: rewriteArm, flips: rewriteFlips },
      // ★ §7 학습이 **이 실행에서** 무엇을 골랐고 무엇을 배웠나. `applied.axes` 가 비어 있으면
      //   이 실행은 어느 셀도 갱신하지 않았다(등급이 없거나 · 그 축이 무연산이었다).
      learning: learningView(),
      plan: { provider: chosen.planner.provider.id, content: clip(plan, EXCERPT_CHARS) },
      // 마지막 스텝만 본문을 온전히 남긴다 — 옛 스텝까지 다 실으면 상한을 넘겨
      // `renderContent` 가 본문을 통째로 버려야 한다.
      steps: steps.map((record2, index) => index === steps.length - 1 ? record2 : stripToExcerpt(record2))
    };
    const content = renderContent(payload);
    if (stopReason === "deadline") {
      return await sealFailure({
        status: "deadline_exceeded",
        error: `\uB370\uB4DC\uB77C\uC778(${effectiveWaitMs}ms)\uC774 \uC9C0\uB098 \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4. \uC2A4\uD15D ${steps.length}/${budget} \uAE4C\uC9C0 \uB3CC\uC558\uC2B5\uB2C8\uB2E4.`,
        recovery: `wait_ms \uB97C \uB298\uB9AC\uAC70\uB098 budget \uC744 \uC904\uC5EC \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC9C0\uAE08\uAE4C\uC9C0\uC758 \uC791\uC5C5\uC740 \uD328\uCE58 \uD30C\uC77C\uB85C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${patchPath}`,
        content,
        stopReason
      });
    }
    if (blockers.length > 0) {
      const first = blockers[0];
      return await sealFailure({
        status: "blocked",
        error: `${first.where}: ${first.error}`,
        recovery: `${first.recovery ?? GENERIC_RECOVERY6} \uC9C0\uAE08\uAE4C\uC9C0\uC758 \uC791\uC5C5\uC740 \uD328\uCE58 \uD30C\uC77C\uB85C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${patchPath}`,
        content,
        stopReason
      });
    }
    if (lastTests?.ran === true && lastTests.passed === false) {
      addNotice("\uD14C\uC2A4\uD2B8\uAC00 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC774 \uD328\uCE58\uB294 \uAC80\uC99D\uC744 \uD1B5\uACFC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    }
    const recovery = buildRecovery2({ stopReason, scopeRecovery, confidence, patchPath, lastTests });
    await release();
    return seal(success({ content, confidence, ...recovery !== null ? { recovery } : {} }), stopReason);
  } catch (error2) {
    const kept = released === false;
    keepWorktree = kept;
    return await sealFailure({
      status: "failed",
      error: `\uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uC158\uC774 \uC608\uAE30\uCE58 \uBABB\uD55C \uC624\uB958\uB85C \uBA48\uCDC4\uC2B5\uB2C8\uB2E4: ${safeText(error2)}`,
      recovery: kept ? `\uC11C\uBC84 \uB85C\uADF8\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uB378\uB9AC\uAC8C\uC774\uD2B8\uC758 \uC791\uC5C5\uC744 \uC783\uC9C0 \uC54A\uC73C\uB824\uACE0 \uC6CC\uD06C\uD2B8\uB9AC\uB97C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${worktree.path} (\uD544\uC694 \uC5C6\uC73C\uBA74 \uB300\uC0C1 \uC800\uC7A5\uC18C\uC5D0\uC11C \`git worktree remove --force\` \uB85C \uC9C0\uC6B0\uC138\uC694).` : "\uC11C\uBC84 \uB85C\uADF8\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC6CC\uD06C\uD2B8\uB9AC\uB294 \uC774\uBBF8 \uD68C\uC218\uD588\uC2B5\uB2C8\uB2E4.",
      ...kept ? { worktree: worktree.path } : {},
      stopReason: "failed"
    });
  } finally {
    deadline?.removeEventListener?.("abort", onDeadlineAbort);
    await release().catch(() => {
    });
    await rm8(planDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function stripToExcerpt(record2) {
  const out = { ...record2 };
  if (out.worker) out.worker = { ...out.worker, content: clip(out.worker.content, OLD_STEP_EXCERPT_CHARS) };
  if (out.verifier) out.verifier = { ...out.verifier, content: clip(out.verifier.content, OLD_STEP_EXCERPT_CHARS) };
  if (out.tests) out.tests = { ...out.tests, output: clip(out.tests.output, OLD_STEP_EXCERPT_CHARS) };
  return out;
}
function describeTests(tests) {
  if (tests.ran !== true) return `\uC2E4\uD589\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 ${tests.reason ?? "\uC0AC\uC720 \uBD88\uBA85"}`;
  return [
    `\uD1B5\uACFC: ${tests.passed === true ? "\uC608" : tests.passed === false ? "\uC544\uB2C8\uC624" : "\uBAA8\uB984"}`,
    `\uC885\uB8CC \uCF54\uB4DC: ${tests.exitCode}${tests.exitCodeExact === false ? " (\uC815\uD655\uD55C \uAC12\uC774 \uC544\uB2D8)" : ""}`,
    tests.output ?? ""
  ].join("\n");
}
async function runStepTests({ testPlan, worktree, runId, deadline, register, runTests: runTests2, phaseStart, step, stage }) {
  phaseStart("tests", step);
  if (testPlan === null) {
    return {
      record: {
        ran: false,
        passed: null,
        confidence: "unverified",
        reason: "\uC774 \uD504\uB85C\uC81D\uD2B8\uC5D0\uC11C \uD14C\uC2A4\uD2B8 \uBA85\uB839\uC744 \uC720\uB3C4\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uCD94\uCE21\uD574\uC11C \uC5C9\uB6B1\uD55C \uBA85\uB839\uC744 \uB3CC\uB9AC\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uAC80\uC99D\uC740 \uC0AC\uB78C\uC774 \uD574\uC57C \uD569\uB2C8\uB2E4."
      },
      unverified: true,
      definitionRejected: false,
      blocked: null
    };
  }
  if (typeof testPlan.command !== "string" || testPlan.command === "") {
    return {
      record: {
        ran: false,
        passed: null,
        confidence: "unverified",
        reason: testPlan.resolveError ?? "\uD14C\uC2A4\uD2B8 \uB3C4\uAD6C\uB97C PATH \uC5D0\uC11C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
      },
      unverified: true,
      definitionRejected: false,
      blocked: null
    };
  }
  const result = await stage(
    "\uD14C\uC2A4\uD2B8 \uC2E4\uD589",
    () => runTests2({
      ...testPlan,
      worktree: worktree.path,
      runId,
      signal: deadline,
      onSpawn: register
    })
  );
  if (isBlocked(result)) {
    const check = result.definitionCheck;
    if (typeof check === "string" && check !== "") {
      return {
        record: {
          ran: false,
          passed: null,
          confidence: "unverified",
          definitionCheck: check,
          reason: result.error
        },
        unverified: true,
        definitionRejected: true,
        blocked: null
      };
    }
    return {
      record: { ran: false, passed: null, confidence: "unverified", reason: result.error },
      unverified: true,
      definitionRejected: false,
      blocked: { where: "runTests", error: result.error, recovery: result.recovery }
    };
  }
  return {
    record: {
      ran: result.ran,
      passed: result.passed,
      exitCode: result.exitCode,
      exitCodeExact: result.exitCodeExact,
      launcher: result.launcher,
      source: result.source,
      definitionCheck: result.definitionCheck,
      timedOut: result.timedOut,
      aborted: result.aborted,
      hung: result.hung,
      lingering: result.lingering,
      confidence: result.confidence,
      notes: result.notes,
      durationMs: result.durationMs,
      output: clip(result.output, TEST_OUTPUT_CHARS)
    },
    unverified: result.confidence !== "verified",
    definitionRejected: false,
    blocked: null
  };
}
function buildRecovery2({ stopReason, scopeRecovery, confidence, patchPath, lastTests }) {
  if (scopeRecovery !== null && scopeRecovery !== void 0) {
    return `${scopeRecovery} \uD328\uCE58\uB294 \uC801\uC6A9\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${patchPath}`;
  }
  if (stopReason === "test-definition-changed") {
    return `\uC6CC\uD06C\uD2B8\uB9AC\uC758 \uD14C\uC2A4\uD2B8 \uC815\uC758\uAC00 \uACE0\uC815\uAC12\uACFC \uB2EC\uB77C \uD14C\uC2A4\uD2B8\uB97C \uB3CC\uB9AC\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uB378\uB9AC\uAC8C\uC774\uD2B8\uC758 \uC218\uC815\uC774 \uC815\uB2F9\uD55C \uAC83\uC77C \uC218 \uC788\uC73C\uBBC0\uB85C \uC791\uC5C5\uC740 \uBC84\uB9AC\uC9C0 \uC54A\uACE0 \uD328\uCE58\uB85C \uB0A8\uACBC\uC2B5\uB2C8\uB2E4: ${patchPath}. \uADF8 \uBCC0\uACBD\uC744 \uC0AC\uB78C\uC774 \uD655\uC778\uD558\uACE0, \uC815\uB2F9\uD558\uB2E4\uBA74 \uD504\uB85C\uC81D\uD2B8 \uCABD \uD14C\uC2A4\uD2B8 \uC815\uC758\uB97C \uAC31\uC2E0\uD55C \uB4A4 \uB2E4\uC2DC \uC720\uB3C4\uD574\uC11C(\uC7AC\uC720\uB3C4) \uC2E4\uD589\uD558\uC138\uC694.`;
  }
  if (confidence === "unverified") {
    const why = lastTests?.ran === true && lastTests.passed === false ? "\uD14C\uC2A4\uD2B8\uAC00 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4." : lastTests?.reason ?? "\uAC80\uC99D\uC744 \uB05D\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
    return `${why} \uD328\uCE58\uB97C \uC801\uC6A9\uD558\uAE30 \uC804\uC5D0 \uACB0\uACFC\uB97C \uC9C1\uC811 \uD655\uC778\uD558\uC138\uC694: ${patchPath}`;
  }
  return null;
}

// src/tools.mjs
import { join as join15 } from "node:path";
var GENERIC_RECOVERY7 = "\uC124\uCE58 \uC0C1\uD0DC\uC640 PATH \uB97C \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
function safeErrorText2(error2) {
  if (typeof error2 === "string") return error2 !== "" ? error2 : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  if (error2 instanceof Error && typeof error2.message === "string" && error2.message !== "") return error2.message;
  try {
    const text = String(error2);
    return text !== "" ? text : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  } catch {
    return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  }
}
var MAX_RECENT_RUNS = 50;
var TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: "orch_models",
    description: "claude\xB7codex \uB450 \uBCA4\uB354\uC758 \uC124\uCE58 \uC0C1\uD0DC\uC640 \uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uBAA8\uB378 \uBAA9\uB85D\uC744 \uC870\uD68C\uD55C\uB2E4.",
    args: Object.freeze({
      refresh: Object.freeze({ type: "boolean", required: false, default: false })
    })
  }),
  Object.freeze({
    name: "orch_run",
    description: "\uC791\uC5C5\uC744 \uB450 \uBCA4\uB354 CLI \uB85C \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uC158\uD55C\uB2E4. \uC77C\uD68C\uC6A9 git \uC6CC\uD06C\uD2B8\uB9AC\uC5D0\uC11C \uC6CC\uCEE4\uAC00 \uACE0\uCE58\uACE0, \uD14C\uC2A4\uD2B8\uB294 \uC774 \uC11C\uBC84\uAC00 \uC9C1\uC811 \uB3CC\uB9AC\uBA70, \uAC80\uC99D\uC790\uAC00 \uC77D\uAE30 \uC804\uC6A9\uC73C\uB85C \uD655\uC778\uD55C\uB2E4. \uACB0\uACFC\uB294 \uC0AC\uC6A9\uC790 \uC800\uC7A5\uC18C\uC5D0 \uC801\uC6A9\uD560 \uC218 \uC788\uB294 \uD328\uCE58\uB2E4. project \uB294 \uC808\uB300 \uACBD\uB85C\uC5EC\uC57C \uD55C\uB2E4 \u2014 MCP stdio \uC11C\uBC84\uC758 cwd \uB294 \uD638\uC2A4\uD2B8\uAC00 \uBB3C\uB824\uC900 \uAC12\uC774\uB77C \uACE0\uC815\uB3FC \uC788\uC9C0 \uC54A\uB2E4.",
    args: Object.freeze({
      // 설계 §8.2. 기본값은 **여기**가 권위다 — 엔진 기본값(budget 1 · waitMs 0)은
      // 라이브러리로서의 최소값이라 도구 층에서 설계값으로 덮는다.
      task: Object.freeze({ type: "string", required: true }),
      // ★ cwd 를 쓰지 않고 절대 경로를 필수로 받는 근거(실측): MCP stdio 서버의 cwd 는
      //   호스트가 물려준 값이라 고정돼 있지 않다. codex 는 자기 cwd 를 그대로 넘긴다.
      //   추측하면 엉뚱한 저장소에 워크트리를 만든다.
      project: Object.freeze({ type: "string", required: true }),
      // ★ 설계 §8.2 는 `in-place`·`read-only` 도 적었지만 그 문장은 §12.0 **이전**이다.
      //   라이브 실측으로 벤더 CLI 의 도구 권한 플래그가 델리게이트의 셸을 제한하지 못한다는
      //   것이 확인돼, 실제로 성립하는 격리가 일회용 워크트리뿐이 됐다. 엔진도 그 둘을
      //   거부한다. 스키마에 남겨 두면 호출자가 지원되는 줄 알고 고르므로 여기서도 뺀다.
      isolation: Object.freeze({
        type: "string",
        required: false,
        default: "worktree",
        enum: ["worktree"]
      }),
      // ★ 수치 제약을 **여기** 적는다. 엔진이 1~10 정수, 0 이상 유한을 강제하는데 도구 층이
      //   그것을 선언도 검증도 안 하면, `budget:2.5` 가 왕복 한 번을 태운 뒤 엔진에서 뒤늦게
      //   거부되고 `budget:NaN` 은 통과한다. 선언과 검증이 어긋나면 그 자체가 결함이다.
      budget: Object.freeze({ type: "number", integer: true, min: 1, max: MAX_BUDGET, required: false, default: 5 }),
      wait_ms: Object.freeze({ type: "number", min: 0, required: false, default: 18e5 }),
      // 설계 §9.2 는 "한 벤더만으로 조용히 돌려 '됐다'고 하면 요청을 배신한다" 고 못박는다.
      // 그래서 single 은 호출자가 **명시적으로** 허용해야만 밴딧이 뽑을 수 있고(계획 3 §7.2),
      // 기본값은 금지 쪽이다. 실제로 팔을 거르는 자리는 `src/learn/bandit.mjs` 의 `decide` 다.
      allow_single: Object.freeze({ type: "boolean", required: false, default: false })
      // ⚠ 설계 §8.2 의 `files`(프로젝트 밖 참고 파일)는 **여기 없다.** 엔진에 소비자가 없어
      //   받아서 버리기만 했고, 선언까지 해 두면 호출자(모델)는 참고 파일을 줬다고 믿고 그
      //   전제 위에서 task 를 짧게 쓴다. 이 기능은 후속 계획으로 이월했다.
    })
  }),
  Object.freeze({
    name: "orch_config",
    // 서술자는 매 세션 tools/list 에 실려 토큰을 먹는다(§8.1). 짧게 쓰되, 스키마가
    // 표현할 수 없는 **인자 사이의 의존**(vendor·tier 는 값과 함께 와야 한다)은 적는다 —
    // `toInputSchema` 는 필드별 제약만 옮길 수 있다.
    description: "\uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uC158\uC774 \uC4F8 \uBAA8\uB378\uACFC effort \uB97C \uC870\uD68C\uD558\uAC70\uB098 \uBC14\uAFC9\uB2C8\uB2E4. \uC778\uC790 \uC5C6\uC774 \uBD80\uB974\uBA74 \uD604\uC7AC \uC124\uC815\uACFC \uACE0\uB97C \uC218 \uC788\uB294 \uAC12\uC744 \uBD05\uB2C8\uB2E4. \uBC14\uAFB8\uB824\uBA74 vendor \uC640 tier \uC5D0 model \uB610\uB294 effort \uB97C \uD568\uAED8 \uC8FC\uC138\uC694. \uBE48 \uBB38\uC790\uC5F4\uC740 \uAC12\uC744 \uC9C0\uC6C1\uB2C8\uB2E4(= CLI \uAE30\uBCF8\uAC12).",
    args: Object.freeze({
      // ★ enum 은 `src/config.mjs` 의 VENDORS 에서 온다 — settings.ini 의 섹션 이름을
      //   아는 것은 그쪽이다. 여기 글자로 적으면 벤더가 늘 때 조용히 갈린다.
      vendor: Object.freeze({ type: "string", required: false, enum: Object.freeze([...VENDORS]) }),
      // ★ tier 도 같은 이유로 `src/config.mjs` 의 TIERS 에서 온다 — 두 줄 위 주석이
      //   금하는 바로 그 "글자로 적기" 가 여기 남아 있었다.
      tier: Object.freeze({ type: "string", required: false, enum: Object.freeze([...TIERS]) }),
      model: Object.freeze({ type: "string", required: false }),
      effort: Object.freeze({ type: "string", required: false })
    })
  }),
  Object.freeze({
    name: "orch_stats",
    description: "\uD559\uC2B5 \uD1B5\uACC4\uB97C \uBD05\uB2C8\uB2E4 \u2014 \uD0DC\uC2A4\uD06C \uD074\uB798\uC2A4 \xD7 \uACB0\uC815 \uCD95 \uC140\uB9C8\uB2E4 \uAD00\uCE21 \uC218\uC640 \uBC34\uB527 \uD65C\uC131 \uC5EC\uBD80. runs \uB97C \uC8FC\uBA74 \uCD5C\uADFC \uC2E4\uD589 \uBAA9\uB85D(run_id \uD3EC\uD568)\uB3C4 \uB0C5\uB2C8\uB2E4. reset \uC740 \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC9C0\uC6C1\uB2C8\uB2E4 \u2014 task_class \uB97C \uD568\uAED8 \uC8FC\uBA74 \uADF8 \uD074\uB798\uC2A4\uC758 \uC140\uB9CC \uC9C0\uC6C1\uB2C8\uB2E4.",
    args: Object.freeze({
      // ★ enum 은 `src/learn/classify.mjs` 의 TASK_CLASSES 에서 온다 — 클래스를 아는 것은
      //   분류기다. 여기 글자로 적으면 클래스가 늘 때 이 도구만 조용히 뒤처진다
      //   (`VENDORS`↔섹션 · `TIERS`↔밴딧 팔 가드와 같은 축).
      task_class: Object.freeze({ type: "string", required: false, enum: Object.freeze([...TASK_CLASSES]) }),
      // ★ `orch_reward` 의 recovery 가 "orch_stats 로 최근 실행 목록을 확인하세요" 라고
      //   가리키므로 그 목록이 실제로 나와야 한다. 기본은 끈다 — 서술자·응답 크기를 매 호출
      //   키우지 않기 위해서다. 상한의 근거는 `MAX_RECENT_RUNS` 주석에 있다.
      runs: Object.freeze({ type: "number", integer: true, min: 0, max: MAX_RECENT_RUNS, required: false, default: 0 }),
      reset: Object.freeze({ type: "boolean", required: false, default: false })
    })
  }),
  Object.freeze({
    name: "orch_reward",
    description: "\uC9C0\uB09C \uC2E4\uD589\uC758 \uD3C9\uAC00\uB97C \uC0AC\uB78C\uC774 \uC815\uC815\uD569\uB2C8\uB2E4. \uC774\uBBF8 \uBC18\uC601\uB41C \uAE30\uC5EC\uB97C \uB418\uB3CC\uB9AC\uACE0 \uC0C8 \uB4F1\uAE09\uC744 \uC801\uC6A9\uD558\uBBC0\uB85C \uAC19\uC740 run_id \uB85C \uC5EC\uB7EC \uBC88 \uBD88\uB7EC\uB3C4 \uACB0\uACFC\uAC00 \uAC19\uC2B5\uB2C8\uB2E4. run_id \uB294 orch_stats({runs: 20}) \uC73C\uB85C \uBD05\uB2C8\uB2E4.",
    args: Object.freeze({
      run_id: Object.freeze({ type: "string", required: true }),
      good: Object.freeze({ type: "boolean", required: true }),
      note: Object.freeze({ type: "string", required: false })
    })
  })
]);
function toInputSchema(argsSpec) {
  const properties = {};
  const required2 = [];
  for (const [key, fieldSpec] of Object.entries(argsSpec)) {
    const property = { type: fieldSpec.integer === true ? "integer" : fieldSpec.type };
    if (fieldSpec.type === "array" && typeof fieldSpec.items === "string") {
      property.items = { type: fieldSpec.items };
    }
    if (Array.isArray(fieldSpec.enum) && fieldSpec.type !== "array") property.enum = fieldSpec.enum;
    if (typeof fieldSpec.min === "number") property.minimum = fieldSpec.min;
    if (typeof fieldSpec.max === "number") property.maximum = fieldSpec.max;
    if (Object.hasOwn(fieldSpec, "default")) property.default = fieldSpec.default;
    properties[key] = property;
    if (fieldSpec.required) required2.push(key);
  }
  const schema = { type: "object", properties, additionalProperties: false };
  if (required2.length > 0) schema.required = required2;
  return schema;
}
function listTools() {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toInputSchema(spec.args)
  }));
}
function safeDescribeError(provider, error2) {
  try {
    const described = provider?.describeError?.(error2);
    if (described && typeof described === "object") {
      return {
        error: typeof described.error === "string" && described.error !== "" ? described.error : safeErrorText2(error2),
        recovery: typeof described.recovery === "string" && described.recovery !== "" ? described.recovery : GENERIC_RECOVERY7
      };
    }
  } catch {
  }
  return { error: safeErrorText2(error2), recovery: GENERIC_RECOVERY7 };
}
function normalizeDiscovered(discovered) {
  if (!discovered || typeof discovered !== "object") {
    return { reachable: false, error: "\uD504\uB85C\uBC14\uC774\uB354\uAC00 \uC54C \uC218 \uC5C6\uB294 \uC751\uB2F5\uC744 \uB0C8\uC2B5\uB2C8\uB2E4.", recovery: GENERIC_RECOVERY7 };
  }
  if (discovered.reachable === true) {
    return {
      reachable: true,
      version: typeof discovered.version === "string" ? discovered.version : null,
      models: Array.isArray(discovered.models) ? discovered.models : []
    };
  }
  const report = {
    reachable: false,
    error: typeof discovered.error === "string" && discovered.error !== "" ? discovered.error : "\uB2FF\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
    recovery: typeof discovered.recovery === "string" && discovered.recovery !== "" ? discovered.recovery : GENERIC_RECOVERY7
  };
  if (discovered.discoveryTimeout === true) report.discoveryTimeout = true;
  return report;
}
async function probeVendor(provider, id, { catalog, refresh, stateRoot: stateRoot2 }) {
  try {
    const cached2 = catalog?.[id];
    const stale = shouldRefresh(catalog, id, POINT_OF_USE_MAX_AGE_MS);
    if (!refresh && !stale && cached2) {
      return { reachable: true, cached: true, fetchedAt: cached2.fetchedAt, models: cached2.models };
    }
    let discovered;
    try {
      discovered = await provider.discover();
    } catch (error2) {
      discovered = { reachable: false, ...safeDescribeError(provider, error2) };
    }
    const report = normalizeDiscovered(discovered);
    if (report.reachable && report.models.length > 0) {
      await writeCatalog(stateRoot2, id, report.models).catch(() => false);
    }
    return report;
  } catch (error2) {
    return { reachable: false, ...safeDescribeError(provider, error2) };
  }
}
async function runOrchModels(value, context) {
  const wired = toEngineDeps(context);
  const providers = Array.isArray(wired.providers) ? wired.providers : listProviders();
  const stateRoot2 = typeof wired.stateRoot === "string" && wired.stateRoot !== "" ? wired.stateRoot : resolveStateRoot();
  const refresh = value.refresh === true;
  const catalog = await readCatalog(stateRoot2);
  const vendors = {};
  await Promise.all(
    providers.map(async (provider, index) => {
      const id = typeof provider?.id === "string" && provider.id !== "" ? provider.id : `unknown-${index}`;
      vendors[id] = await probeVendor(provider, id, { catalog, refresh, stateRoot: stateRoot2 });
    })
  );
  return success({ content: JSON.stringify({ vendors }) });
}
var TIER_FIELDS2 = Object.freeze(
  Object.fromEntries(TIERS.map((tier) => [tier, Object.freeze({ model: tier, effort: `${tier}Effort` })]))
);
async function describeCatalog(stateRoot2) {
  const catalog = await readCatalog(stateRoot2);
  const vendors = {};
  for (const id of VENDORS) {
    const entry = catalog[id];
    vendors[id] = {
      models: Array.isArray(entry?.models) ? entry.models : [],
      fetchedAt: typeof entry?.fetchedAt === "string" ? entry.fetchedAt : null
    };
  }
  return vendors;
}
function emptyCatalogNotice(vendors) {
  const empty = VENDORS.filter((id) => vendors[id].models.length === 0);
  if (empty.length === 0) return null;
  return `${empty.join(", ")} \uC758 \uBAA8\uB378 \uBAA9\uB85D\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4 \u2014 orch_models \uB97C \uBA3C\uC800 \uBD80\uB974\uBA74 \uCE74\uD0C8\uB85C\uADF8\uAC00 \uCC44\uC6CC\uC9D1\uB2C8\uB2E4. \uBAA9\uB85D\uC774 \uC5C6\uB294 \uBCA4\uB354\uB294 effort \uAC80\uC0AC\uB97C \uAC74\uB108\uB701\uB2C8\uB2E4.`;
}
function unknownModelNotice(vendorId, model, vendors) {
  if (typeof model !== "string") return null;
  const name = model.trim();
  if (name === "") return null;
  const list = vendors[vendorId].models;
  if (list.length === 0 || list.some((entry) => entry?.name === name)) return null;
  return `'${name}' \uC740 \uC9C0\uAE08 \uBC1C\uACAC\uB41C ${vendorId} \uBAA9\uB85D\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 \uC624\uD0C0\uAC00 \uC544\uB2CC\uC9C0 \uD655\uC778\uD558\uC138\uC694. \uC0C8 \uBAA8\uB378\uC774\uBA74 \uADF8\uB300\uB85C \uC501\uB2C8\uB2E4.`;
}
function configView(current, vendors, notices) {
  const notice = notices.filter((text) => typeof text === "string" && text !== "").join(" ");
  return success({
    content: JSON.stringify({ current, vendors }),
    confidence: "verified",
    notice: notice !== "" ? notice : void 0
  });
}
async function runOrchConfig(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot2 = typeof wired.stateRoot === "string" && wired.stateRoot !== "" ? wired.stateRoot : resolveStateRoot();
  const vendors = await describeCatalog(stateRoot2);
  const changing = value.model !== void 0 || value.effort !== void 0;
  if (!changing) {
    if (value.vendor !== void 0 || value.tier !== void 0) {
      return failure({
        status: "invalid",
        error: "vendor\xB7tier \uB9CC\uC73C\uB85C\uB294 \uBC14\uAFC0 \uAC83\uC774 \uC5C6\uC2B5\uB2C8\uB2E4 \u2014 model \uC774\uB098 effort \uB97C \uC8FC\uC138\uC694.",
        recovery: "model \uC774\uB098 effort \uB97C \uD568\uAED8 \uC8FC\uC138\uC694. \uC870\uD68C\uB9CC \uD558\uB824\uBA74 \uC778\uC790 \uC5C6\uC774 \uBD80\uB974\uC138\uC694."
      });
    }
    return configView(await readSettings(stateRoot2), vendors, [emptyCatalogNotice(vendors)]);
  }
  if (value.vendor === void 0 || value.tier === void 0) {
    return failure({
      status: "invalid",
      error: "model\xB7effort \uB97C \uBC14\uAFB8\uB824\uBA74 vendor \uC640 tier \uB97C \uD568\uAED8 \uC8FC\uC138\uC694.",
      recovery: `vendor: ${VENDORS.join(", ")} / tier: ${TIERS.join(", ")}`
    });
  }
  const fields = TIER_FIELDS2[value.tier];
  const patch = { [value.vendor]: {} };
  if (value.model !== void 0) patch[value.vendor][fields.model] = value.model;
  if (value.effort !== void 0) patch[value.vendor][fields.effort] = value.effort;
  const models = {};
  for (const id of VENDORS) models[id] = vendors[id].models.length > 0 ? vendors[id].models : null;
  const wrote = await writeSettings(stateRoot2, patch, { models });
  if (!wrote.ok) return failure({ status: "invalid", error: wrote.error, recovery: wrote.recovery });
  return configView(wrote.settings, vendors, [
    unknownModelNotice(value.vendor, wrote.settings[value.vendor][fields.model], vendors),
    emptyCatalogNotice(vendors),
    wrote.notice
  ]);
}
var AXIS_NOTES = Object.freeze({
  mix: "allow_single:true \uB85C \uBD80\uB978 \uC2E4\uD589\uC5D0\uC11C\uB9CC \uC774 \uCD95\uC758 \uD314\uC774 \uB458\uC774 \uB429\uB2C8\uB2E4(\uC124\uACC4 \xA79.2) \u2014 \uADF8 \uC804\uC5D0\uB294 \uAD00\uCE21\uC774 \uC313\uC5EC\uB3C4 \uAE30\uBCF8\uAC12\uC73C\uB85C \uB3D5\uB2C8\uB2E4.",
  placement: "single \uC2E4\uD589\uC758 \uAD00\uCE21\uB3C4 \uC774 \uC140\uC5D0 \uD569\uC0B0\uB429\uB2C8\uB2E4 \u2014 \u300C\uB204\uAC00 \uBA3C\uC800 \uD558\uB098\u300D\uC640 \u300C\uD63C\uC790\uBA74 \uB204\uAD6C\uC778\uAC00\u300D\uAC00 \uD55C \uC140\uC5D0 \uC313\uC785\uB2C8\uB2E4(\uD0DC\uC2A4\uD06C 8 \uACB0\uC815 \u2461)."
});
function splitCellKey(cellKey) {
  const at = cellKey.indexOf("::");
  if (at === -1) return { taskClass: null, axis: null };
  return { taskClass: cellKey.slice(0, at), axis: cellKey.slice(at + 2) };
}
function cellView(cellKey, arms) {
  const { taskClass, axis } = splitCellKey(cellKey);
  const spec = axis !== null && Object.hasOwn(AXES, axis) ? AXES[axis] : null;
  const observations = spec === null ? null : observationsOf(arms, spec.arms);
  const candidates = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, false));
  const withSingle = spec === null ? [] : spec.arms.filter((arm) => armAllowed(axis, arm, true));
  const optInArms = spec === null ? [] : spec.arms.filter((arm) => !armAllowed(axis, arm, false));
  const enough = observations !== null && observations >= OBSERVATION_THRESHOLD;
  const view = {
    cellKey,
    taskClass,
    axis,
    arms,
    observations,
    banditActiveByDefault: enough && candidates.length >= 2,
    banditActiveIfAllowSingle: enough && withSingle.length >= 2
  };
  if (spec === null) view.unknownAxis = true;
  if (optInArms.length > 0) view.optInArms = optInArms;
  if (axis !== null && Object.hasOwn(AXIS_NOTES, axis)) view.note = AXIS_NOTES[axis];
  return view;
}
var recentView = (run3, generations, generationsKnown = true) => {
  const appliedAxes = Array.isArray(run3.appliedAxes) ? run3.appliedAxes : null;
  const appliedCurrent = run3.appliedGrade === null || run3.appliedGrade === void 0 ? null : !generationsKnown ? null : appliedAxes !== null && typeof run3.taskClass === "string" ? appliedAxes.every((axis) => {
    const recorded = Number.isInteger(run3.appliedGenerations?.[axis]) ? run3.appliedGenerations[axis] : 0;
    return generationOf(generations, cellKeyOf(run3.taskClass, axis)) === recorded;
  }) : null;
  return {
    runId: run3.runId,
    at: Number.isFinite(run3.at) ? run3.at : null,
    taskClass: typeof run3.taskClass === "string" ? run3.taskClass : null,
    stopReason: run3.outcome?.stopReason ?? null,
    grade: run3.outcome?.grade ?? null,
    appliedGrade: run3.appliedGrade ?? null,
    appliedCurrent,
    appliedAxes
  };
};
function renderStats(view) {
  const allCells = view.cells;
  const allRecent = view.recent;
  let keepRecent = allRecent === null ? 0 : allRecent.length;
  let keepCells = allCells.length;
  let withArms = true;
  for (let step = 0; step < 128; step += 1) {
    const reduced = {};
    if (allRecent !== null && keepRecent < allRecent.length) {
      reduced.recent = { asked: allRecent.length, kept: keepRecent };
    }
    if (!withArms) reduced.arms = false;
    if (keepCells < allCells.length) reduced.cells = { asked: allCells.length, kept: keepCells };
    const body = {
      threshold: view.threshold,
      posteriors: view.posteriors,
      journal: view.journal,
      cells: allCells.slice(0, keepCells).map((cell) => withArms ? cell : { ...cell, arms: null })
    };
    if (allRecent !== null) {
      body.recent = allRecent.slice(0, keepRecent);
      body.recentFiltered = false;
    }
    if (Object.keys(reduced).length > 0) body.reduced = reduced;
    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS) return { text, reduced };
    if (keepRecent > 0) {
      keepRecent = Math.floor(keepRecent / 2);
      continue;
    }
    if (withArms) {
      withArms = false;
      continue;
    }
    if (keepCells > 0) {
      keepCells = Math.floor(keepCells / 2);
      continue;
    }
    return { text, reduced };
  }
  return { text: JSON.stringify({ threshold: view.threshold, posteriors: view.posteriors, journal: view.journal, cells: [] }), reduced: {} };
}
function renderReset(reset) {
  const all = reset.cellKeys;
  let kept = all === null ? 0 : all.length;
  for (let step = 0; step < 128; step += 1) {
    const body = { reset: { ...reset, cellKeys: all === null ? null : all.slice(0, kept) } };
    const reduced = all !== null && kept < all.length ? { cellKeys: { asked: all.length, kept } } : {};
    if (all !== null && kept < all.length) body.reduced = reduced;
    const text = JSON.stringify(body);
    if (text.length <= MAX_CONTENT_CHARS || kept === 0) return { text, reduced };
    kept = Math.floor(kept / 2);
  }
  return { text: JSON.stringify({ reset: { ...reset, cellKeys: [] } }), reduced: {} };
}
var RESET_KEY_CHARS = 100;
var RESET_REASON_CHARS = 120;
var RESET_NOTE_CHARS = 240;
var RESET_NOTES_KEPT = 5;
var clipTo = (text, limit) => {
  const value = typeof text === "string" ? text : String(text);
  return value.length > limit ? `${value.slice(0, limit)}\u2026` : value;
};
function foldResetNotes(notes) {
  const kept = (Array.isArray(notes) ? notes : []).filter((note) => typeof note === "string" && note !== "").map((note) => clipTo(note, RESET_NOTE_CHARS));
  if (kept.length === 0) return void 0;
  if (kept.length <= RESET_NOTES_KEPT) return kept.join(" / ");
  const dropped = kept.length - RESET_NOTES_KEPT;
  return `${kept.slice(0, RESET_NOTES_KEPT).join(" / ")} (\uADF8 \uBC16\uC5D0 ${dropped}\uAC74\uC740 \uC811\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uC2E4\uD328\uD55C \uC140 \uC218\uB294 \uBCF8\uBB38 reset.failed \uC785\uB2C8\uB2E4.)`;
}
function reductionNotice(reduced) {
  const parts = [];
  if (reduced.recent) parts.push(`\uCD5C\uADFC \uC2E4\uD589 \uBAA9\uB85D\uC744 ${reduced.recent.asked}\uAC74\uC5D0\uC11C ${reduced.recent.kept}\uAC74\uC73C\uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4`);
  if (reduced.arms === false) parts.push("\uD314\uBCC4 \u03B1\xB7\u03B2 \uB97C \uBE90\uC2B5\uB2C8\uB2E4");
  if (reduced.cells) parts.push(`\uC140 \uBAA9\uB85D\uC744 ${reduced.cells.asked}\uAC1C\uC5D0\uC11C ${reduced.cells.kept}\uAC1C\uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4`);
  if (reduced.cellKeys) {
    parts.push(`\uC9C0\uC6B4 \uC140 \uBAA9\uB85D\uC744 ${reduced.cellKeys.asked}\uAC1C\uC5D0\uC11C ${reduced.cellKeys.kept}\uAC1C\uB85C \uC904\uC600\uC2B5\uB2C8\uB2E4(\uC2E4\uC81C\uB85C \uC9C0\uC6B4 \uC218\uB294 cleared \uC785\uB2C8\uB2E4)`);
  }
  return parts.length > 0 ? `\uC751\uB2F5 \uC0C1\uD55C(${MAX_CONTENT_CHARS}\uC790) \uB54C\uBB38\uC5D0 ${parts.join(" / ")}.` : null;
}
async function resetStats(stateRoot2, taskClass, preNotes, operationOptions) {
  const snapshotFor = () => ({
    path: join15(stateRoot2, SNAPSHOT_FILE),
    generationPath: join15(stateRoot2, GENERATIONS_SNAPSHOT_FILE),
    restore: `\uAD00\uB828 \uC11C\uBC84\uB97C \uC911\uC9C0\uD55C \uC0C1\uD0DC\uC5D0\uC11C ${GENERATIONS_SNAPSHOT_FILE} \uC744 learning.generations.json \uC73C\uB85C \uBA3C\uC800 \uBCF5\uC0AC\uD55C \uB4A4 ${SNAPSHOT_FILE} \uC744 posteriors.json \uC73C\uB85C \uBCF5\uC0AC\uD558\uACE0 \uC11C\uBC84\uB97C \uB2E4\uC2DC \uC2DC\uC791\uD558\uC138\uC694.`
  });
  const snapshotNotice = (snapshot) => `reset \uC804 \uC2A4\uB0C5\uC0F7\uC740 ${snapshot.path} \uBC0F ${snapshot.generationPath} \uC785\uB2C8\uB2E4. \uB418\uB3CC\uB9AC\uB824\uBA74 \uAD00\uB828 \uC11C\uBC84\uB97C \uC911\uC9C0\uD55C \uC0C1\uD0DC\uC5D0\uC11C ${GENERATIONS_SNAPSHOT_FILE} \uC744 learning.generations.json \uC73C\uB85C \uBA3C\uC800 \uBCF5\uC0AC\uD55C \uB4A4 ${SNAPSHOT_FILE} \uC744 posteriors.json \uC73C\uB85C \uBCF5\uC0AC\uD558\uACE0 \uC11C\uBC84\uB97C \uB2E4\uC2DC \uC2DC\uC791\uD558\uC138\uC694.`;
  if (taskClass === void 0) {
    const cleared2 = await resetPosteriors(stateRoot2, operationOptions);
    if (!cleared2.ok) {
      return failure({
        status: "failed",
        error: `\uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${cleared2.reason}`,
        recovery: "\uC7A0\uC2DC \uB4A4 \uAC19\uC740 reset \uC744 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uBCF4\uB958 \uC911\uC778 \uC791\uC5C5\uC740 \uB2E4\uC74C \uC870\uD68C\uAC00 \uBCF5\uAD6C\uD569\uB2C8\uB2E4. \uD544\uC694\uD558\uBA74 \uAD00\uB828 \uC11C\uBC84\uB97C \uC911\uC9C0\uD558\uACE0 paired snapshot \uBCF5\uAD6C \uC808\uCC28\uB97C \uB530\uB974\uC138\uC694."
      });
    }
    return success({
      // ★ `asked` 는 **모른다**(`null`). 전체 초기화는 셀을 세지 않고 파일을 통째로 버리므로
      //   "몇 개가 범위였나"에 답할 근거가 없다 — `cleared` 를 그대로 적으면 손상된 파일을
      //   버렸을 때(`cleared:0`) "범위가 0개였다"는 거짓이 된다. 범위 reset 응답과 필드
      //   집합을 맞춰 소비자가 두 갈래로 분기하지 않게 한다.
      //
      // ★★ `posteriors` 가 **읽지도 못한 채 버렸다**를 본문에 낸다. 이 필드가 없던 동안
      //    손상 파일을 버린 응답의 본문이 지울 것이 아예 없던 경우와 **바이트로 같았다**
      //    (실측, 수정 라운드 1 · 커밋 ab0e98a · 둘 다
      //    `{"reset":{"taskClass":null,"asked":null,"cleared":0,"failed":0,"cellKeys":null}}`
      //    · 둘 다 `verified`). 그 사실은 한국어 notice 안에만 있었다 — 이 파일이 §3② 에서
      //    이미 세운 기준(「notice 에만 있으면 본문 소비자는 못 본다」)을 자기 자매 갈래에
      //    못 적용한 것이다.
      //    이름과 값(`ok`/`unreadable`)은 **조회 갈래의 최상위 `posteriors`** 와 같게 맞췄다.
      //    자매끼리 어휘가 갈리면 소비자가 같은 사실을 두 번 배워야 한다.
      content: JSON.stringify({
        reset: {
          taskClass: null,
          asked: null,
          cleared: cleared2.cleared,
          failed: 0,
          cellKeys: null,
          posteriors: cleared2.discarded ? "unreadable" : "ok",
          snapshot: cleared2.cleared > 0 || cleared2.discarded ? snapshotFor() : null
        }
      }),
      // ★ 조회 갈래가 손상에 `unverified` 를 내는 것과 **같은 규칙**이다. 읽지도 못한 파일을
      //   버린 것을 "직접 확인했다" 고 말할 수 없다.
      confidence: cleared2.discarded ? "unverified" : "verified",
      notice: foldResetNotes([
        ...preNotes,
        cleared2.cleared > 0 || cleared2.discarded ? snapshotNotice(snapshotFor()) : null,
        cleared2.notice
      ])
    });
  }
  const head = [...preNotes];
  const one = await resetPosteriors(stateRoot2, { taskClass, ...operationOptions ?? {} });
  if (!one.ok && !Number.isInteger(one.asked)) {
    return failure({
      status: "failed",
      error: `\uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC77D\uC9C0 \uBABB\uD574 ${taskClass} \uBC94\uC704\uB9CC \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${one.reason}`,
      recovery: "task_class \uC5C6\uC774 orch_stats({reset:true}) \uB85C \uBD80\uB974\uBA74 \uC77D\uC744 \uC218 \uC5C6\uB294 \uD30C\uC77C\uC744 \uD1B5\uC9F8\uB85C \uBC84\uB9BD\uB2C8\uB2E4."
    });
  }
  const asked = Number.isInteger(one.asked) ? one.asked : 0;
  const cleared = one.ok ? one.cleared : 0;
  const failed = one.ok ? 0 : asked;
  const selectedKeys = Array.isArray(one.cellKeys) ? one.cellKeys : [];
  const removed = one.ok ? selectedKeys : [];
  const perCell = one.ok ? [one.notice] : selectedKeys.map((cellKey) => `${clipTo(cellKey, RESET_KEY_CHARS)} \uB97C \uC9C0\uC6B0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${clipTo(one.reason, RESET_REASON_CHARS)}`);
  const rendered = renderReset({
    taskClass,
    asked,
    cleared,
    failed,
    cellKeys: removed,
    posteriors: "ok",
    snapshot: cleared > 0 ? snapshotFor() : null
  });
  const shrank = reductionNotice(rendered.reduced);
  if (shrank !== null) head.push(shrank);
  return success({
    content: rendered.text,
    // ★ 하나라도 못 지웠으면 "직접 확인했다"고 말할 수 없다. status 는 `succeeded` 로 둔다 —
    //   reset 은 멱등이라 같은 호출을 그대로 다시 하면 남은 것을 마저 지운다.
    confidence: failed === 0 ? "verified" : "unverified",
    notice: foldResetNotes([...head, cleared > 0 ? snapshotNotice(snapshotFor()) : null, ...perCell])
  });
}
async function runOrchStats(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot2 = typeof wired.stateRoot === "string" && wired.stateRoot !== "" ? wired.stateRoot : resolveStateRoot();
  if (value.reset === true) {
    const ignored = value.runs > 0 ? [`reset \uD638\uCD9C\uC774\uB77C runs:${value.runs} \uB294 \uBB34\uC2DC\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uCD5C\uADFC \uC2E4\uD589 \uBAA9\uB85D\uC740 reset \uC5C6\uC774 \uB2E4\uC2DC \uBD80\uB974\uC138\uC694.`] : [];
    return resetStats(stateRoot2, value.task_class, ignored, wired.learningOperationOptions);
  }
  const notices = [];
  const snapshot = await withLearningLock(stateRoot2, async () => ({
    posteriors: await readPosteriorsUnlocked(stateRoot2),
    generations: await readGenerationsUnlocked(stateRoot2),
    runs: value.runs > 0 ? await readRunsUnlocked(stateRoot2, { limit: value.runs }) : null
  }));
  const posteriors = snapshot.ok ? snapshot.value.posteriors : { ok: false, reason: `\uD559\uC2B5 coordinator \uBCF5\uAD6C \uB610\uB294 \uC7A0\uAE08 \uC2E4\uD328: ${snapshot.reason}` };
  const generationState = snapshot.ok ? snapshot.value.generations : { ok: false, reason: snapshot.reason };
  const runs = snapshot.ok ? snapshot.value.runs : null;
  if (!posteriors.ok) notices.push(`\uD559\uC2B5 \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${posteriors.reason}`);
  const cells = posteriors.ok ? Object.entries(posteriors.cells).map(([cellKey, arms]) => cellView(cellKey, arms)).filter((cell) => value.task_class === void 0 || cell.taskClass === value.task_class) : [];
  if (!generationState.ok) notices.push(`\uD559\uC2B5 \uC138\uB300\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${generationState.reason}`);
  let recent = null;
  let journal = "skipped";
  if (value.runs > 0) {
    if (runs?.ok) {
      recent = [...runs.runs].reverse().map((run3) => recentView(run3, generationState.ok ? generationState.generations : { global: 0, cells: {} }, generationState.ok));
      journal = "ok";
    } else {
      recent = [];
      journal = "unreadable";
      notices.push(`\uC2E4\uD589 \uC800\uB110\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${runs?.reason ?? snapshot.reason}`);
    }
  }
  const rendered = renderStats({
    threshold: OBSERVATION_THRESHOLD,
    posteriors: posteriors.ok ? "ok" : "unreadable",
    journal,
    cells,
    recent
  });
  const shrank = reductionNotice(rendered.reduced);
  if (shrank !== null) notices.push(shrank);
  return success({
    content: rendered.text,
    // 파일을 직접 읽은 값이다. 못 읽은 것이 하나라도 있으면 그렇게 말한다.
    confidence: posteriors.ok && journal !== "unreadable" && generationState.ok ? "verified" : "unverified",
    notice: notices.length > 0 ? notices.join(" ") : void 0
  });
}
var ZERO_DELTA = Object.freeze({ alphaDelta: 0, betaDelta: 0 });
var sameAxes = (a, b) => Array.isArray(a) && a.length === b.length && a.every((axis, i) => axis === b[i]);
async function runOrchReward(value, context) {
  const wired = toEngineDeps(context);
  const stateRoot2 = typeof wired.stateRoot === "string" && wired.stateRoot !== "" ? wired.stateRoot : resolveStateRoot();
  const locked = await withLearningLock(stateRoot2, async () => runOrchRewardUnlocked(value, stateRoot2));
  if (locked.ok) return locked.value;
  return failure({
    status: "failed",
    error: `\uD559\uC2B5 \uC870\uC815 \uC7A0\uAE08\uC744 \uC7A1\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${locked.reason}`,
    recovery: "\uC7A0\uC2DC \uB4A4 \uAC19\uC740 run_id \uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uBCF4\uB958 \uC911\uC778 \uD559\uC2B5 \uC791\uC5C5\uC740 \uB2E4\uC74C \uC77D\uAE30 \uB610\uB294 \uC7AC\uC2DC\uB3C4\uC5D0\uC11C \uBCF5\uAD6C\uB429\uB2C8\uB2E4."
  });
}
async function runOrchRewardUnlocked(value, stateRoot2) {
  const run3 = await findRunUnlocked(stateRoot2, value.run_id);
  if (run3 === null) {
    return failure({
      status: "invalid",
      error: `run_id "${safeErrorText2(value.run_id)}" \uB97C \uC800\uB110\uC5D0\uC11C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.`,
      recovery: "orch_stats({runs: 20}) \uC73C\uB85C \uCD5C\uADFC \uC2E4\uD589 \uBAA9\uB85D\uC744 \uD655\uC778\uD558\uC138\uC694."
    });
  }
  if (typeof run3.taskClass !== "string" || run3.taskClass === "") {
    return failure({
      status: "failed",
      error: `\uC2E4\uD589 \uAE30\uB85D "${safeErrorText2(value.run_id)}" \uC5D0 taskClass \uAC00 \uC5C6\uC5B4 \uC5B4\uB290 \uC140\uC744 \uACE0\uCE60\uC9C0 \uC54C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
      recovery: "\uC774 \uC2E4\uD589\uC740 \uD559\uC2B5 \uC140\uACFC \uC5F0\uACB0\uB3FC \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E4\uB978 run_id \uB97C \uACE0\uB974\uC138\uC694."
    });
  }
  const generations = await readGenerationsUnlocked(stateRoot2);
  if (!generations.ok) {
    return failure({
      status: "failed",
      error: `\uD559\uC2B5 \uC138\uB300\uB97C \uC77D\uC9C0 \uBABB\uD574 \uC815\uC815\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4: ${generations.reason}`,
      recovery: "\uC7A0\uC2DC \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uC0C1\uD0DC \uB8E8\uD2B8\uC758 learning.generations.json \uC811\uADFC\uB3C4 \uD655\uC778\uD558\uC138\uC694."
    });
  }
  const hasExpiredAxis = (axes2, recordedGenerations) => axes2.some((axis) => {
    if (typeof axis !== "string" || axis === "") return false;
    const recorded = Number.isInteger(recordedGenerations?.[axis]) ? recordedGenerations[axis] : 0;
    return generationOf(generations.generations, cellKeyOf(run3.taskClass, axis)) !== recorded;
  });
  const isExpired = run3.appliedGrade !== null && run3.appliedGrade !== void 0 && Array.isArray(run3.appliedAxes) && hasExpiredAxis(run3.appliedAxes, run3.appliedGenerations) || Array.isArray(run3.rewardableAxes) && hasExpiredAxis(run3.rewardableAxes, run3.rewardableGenerations);
  if (isExpired) {
    return failure({
      status: "invalid",
      error: "\uC774 \uC2E4\uD589\uC758 \uD559\uC2B5 \uC138\uB300\uAC00 reset \uC73C\uB85C \uB9CC\uB8CC\uB418\uC5B4 \uC815\uC815\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
      recovery: "\uC0C8 orchestration \uC744 \uC2E4\uD589\uD574 \uD604\uC7AC \uD559\uC2B5 \uC138\uB300\uC758 run_id \uB97C \uB9CC\uB4E0 \uB4A4 \uADF8 \uC2E4\uD589\uC744 \uC815\uC815\uD558\uC138\uC694."
    });
  }
  const nextGrade = value.good === true ? "success" : "failure";
  const redoDeltas = gradeToDeltas(nextGrade);
  const appliedGrade = run3.appliedGrade ?? null;
  const undoDeltas = gradeToDeltas(appliedGrade);
  if (appliedGrade !== null && undoDeltas === null) {
    return failure({
      status: "failed",
      error: `\uC2E4\uD589 \uAE30\uB85D\uC774 \uBAA8\uB974\uB294 \uB4F1\uAE09(${safeErrorText2(appliedGrade)})\uC744 \uBC18\uC601\uD588\uB2E4\uACE0 \uC801\uACE0 \uC788\uC5B4 \uB418\uB3CC\uB9B4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
      recovery: "\uB418\uB3CC\uB9AC\uC9C0 \uC54A\uACE0 \uC0C8 \uB4F1\uAE09\uB9CC \uB354\uD558\uBA74 \uC774\uC911 \uACC4\uC0B0\uC774 \uB429\uB2C8\uB2E4. \uC800\uB110 \uC904\uC744 \uD655\uC778\uD558\uC138\uC694."
    });
  }
  if (undoDeltas !== null && !Array.isArray(run3.appliedAxes)) {
    return failure({
      status: "failed",
      error: "\uC2E4\uD589 \uAE30\uB85D\uC5D0 appliedAxes \uAC00 \uC5C6\uC2B5\uB2C8\uB2E4(\uC61B \uD615\uC2DD) \u2014 \uC5B4\uB290 \uC140\uC5D0 \uBC18\uC601\uB410\uB294\uC9C0 \uBAB0\uB77C \uB418\uB3CC\uB9B4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
      recovery: "\uB418\uB3CC\uB9AC\uC9C0 \uC54A\uACE0 \uC0C8 \uB4F1\uAE09\uB9CC \uB354\uD558\uBA74 \uC774\uC911 \uACC4\uC0B0\uC774 \uB429\uB2C8\uB2E4. orch_stats({reset:true}) \uB85C \uC0AC\uD6C4\uBD84\uD3EC\uB97C \uCD08\uAE30\uD654\uD558\uACE0 \uB2E4\uC2DC \uC313\uB294 \uAC83\uC774 \uD68C\uBCF5 \uACBD\uB85C\uC785\uB2C8\uB2E4."
    });
  }
  const undoAxes = undoDeltas === null ? [] : run3.appliedAxes;
  const notes = [];
  let redoAxes;
  if (Array.isArray(run3.rewardableAxes)) {
    redoAxes = run3.rewardableAxes;
  } else if (undoDeltas !== null) {
    redoAxes = undoAxes;
    notes.push("\uC2E4\uD589 \uAE30\uB85D\uC5D0 rewardableAxes \uAC00 \uC5C6\uC5B4(\uC61B \uD615\uC2DD) \uC774\uBBF8 \uBC18\uC601\uB3FC \uC788\uB358 \uCD95\uC5D0\uB9CC \uC0C8 \uB4F1\uAE09\uC744 \uC801\uC5C8\uC2B5\uB2C8\uB2E4.");
  } else {
    redoAxes = [];
    notes.push(
      "\uC2E4\uD589 \uAE30\uB85D\uC5D0 rewardableAxes \uAC00 \uC5C6\uACE0 \uC0AC\uD6C4\uBD84\uD3EC\uC5D0 \uBC18\uC601\uB41C \uAE30\uC5EC\uB3C4 \uC5C6\uC5B4(\uC61B \uD615\uC2DD) \uC0C8 \uB4F1\uAE09\uC744 \uC801\uC744 \uC140\uC744 \uC815\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."
    );
  }
  const named = [.../* @__PURE__ */ new Set([...undoAxes, ...redoAxes])];
  const axes = named.filter((axis) => Object.hasOwn(AXES, axis));
  const unknown2 = named.filter((axis) => !Object.hasOwn(AXES, axis));
  if (unknown2.length > 0) {
    notes.push(`\uC9C0\uAE08 \uC5C6\uB294 \uCD95\uC774\uB77C \uAC74\uB108\uB701\uB2C8\uB2E4: ${unknown2.map((axis) => safeErrorText2(axis)).join(", ")}.`);
  }
  const holding = [];
  const updates = [];
  for (const axis of axes) {
    const decisions = run3.decisions !== null && typeof run3.decisions === "object" ? run3.decisions : {};
    const arm = Object.hasOwn(decisions, axis) ? decisions[axis] : null;
    if (typeof arm !== "string" || arm === "") {
      notes.push(`${axis}: \uC774 \uC2E4\uD589\uC774 \uC4F4 \uD314\uC774 \uC800\uB110\uC5D0 \uC5C6\uC5B4 \uAC74\uB108\uB701\uB2C8\uB2E4.`);
      continue;
    }
    const back = undoAxes.includes(axis) ? undoDeltas ?? ZERO_DELTA : ZERO_DELTA;
    const inRedo = redoAxes.includes(axis);
    const forward = inRedo ? redoDeltas : ZERO_DELTA;
    const alphaDelta = forward.alphaDelta - back.alphaDelta;
    const betaDelta = forward.betaDelta - back.betaDelta;
    if (alphaDelta !== 0 || betaDelta !== 0) {
      updates.push({ cellKey: cellKeyOf(run3.taskClass, axis), arm, alphaDelta, betaDelta });
    }
    if (inRedo) holding.push(axis);
  }
  const wrote = updates.length > 0;
  const nextApplied = holding.length > 0 ? nextGrade : null;
  const note = typeof value.note === "string" ? value.note : null;
  if (note === null && typeof run3.note === "string" && run3.note !== "") {
    notes.push(`note \uB97C \uC8FC\uC9C0 \uC54A\uC544 \uC774\uC804 \uAE30\uB85D("${run3.note}")\uC744 \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4. \uB0A8\uAE30\uB824\uBA74 \uAC19\uC740 \uBB38\uC7A5\uC744 \uB2E4\uC2DC \uC8FC\uC138\uC694.`);
  }
  const unchanged = !wrote && appliedGrade === nextApplied && sameAxes(run3.appliedAxes, holding) && (run3.rewardApplied ?? null) === "user" && (run3.note ?? null) === note;
  if (!unchanged) {
    const committed = await commitLearningMutationUnlocked(stateRoot2, {
      updates,
      journal: {
        ...run3,
        appliedGrade: nextApplied,
        appliedAxes: holding,
        rewardApplied: "user",
        note
      }
    });
    if (committed.ok !== true) {
      return failure({
        status: "failed",
        error: `\uC0AC\uD6C4\uBD84\uD3EC\uC640 \uC2E4\uD589 \uAE30\uB85D\uC744 \uD568\uAED8 \uACE0\uCE58\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${committed.reason}`,
        recovery: "\uBCF4\uB958 \uC911\uC778 \uC791\uC5C5\uC740 \uB2E4\uC74C \uC77D\uAE30 \uB610\uB294 \uAC19\uC740 run_id \uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD560 \uB54C \uBCF5\uAD6C\uB429\uB2C8\uB2E4. \uBB38\uC81C\uAC00 \uACC4\uC18D\uB418\uBA74 \uC0C8 orchestration \uC744 \uC2E4\uD589\uD558\uC138\uC694."
      });
    }
    if (Array.isArray(committed.notes) && committed.notes.length > 0) notes.push(committed.notes.join(" / "));
  }
  return success({
    content: JSON.stringify({
      runId: run3.runId,
      previousGrade: appliedGrade,
      grade: nextApplied,
      axes: holding,
      changed: !unchanged
    }),
    confidence: "verified",
    notice: notes.length > 0 ? notes.join(" / ") : void 0
  });
}
function toEngineDeps(context) {
  const deps = context?.deps && typeof context.deps === "object" ? context.deps : {};
  const shorthand = {};
  if (typeof context?.stateRoot === "string" && context.stateRoot !== "") shorthand.stateRoot = context.stateRoot;
  if (Array.isArray(context?.providers)) shorthand.providers = context.providers;
  return { ...shorthand, ...deps };
}
function toEngineOptions(value, context) {
  return {
    task: value.task,
    projectPath: value.project,
    isolation: value.isolation,
    budget: value.budget,
    waitMs: value.wait_ms,
    // ☞ 태스크 8 이 읽는다: `decide({ allowed: { single: options.allowSingle === true } })`.
    allowSingle: value.allow_single === true,
    onProgress: typeof context?.onProgress === "function" ? context.onProgress : void 0,
    deps: toEngineDeps(context)
  };
}
async function runOrchRun(value, context) {
  return runOrchestration(toEngineOptions(value, context));
}
var PROGRESS_MIN_INTERVAL_MS = 5e3;
function makeProgressReporter({ sendNotification, progressToken, minIntervalMs, now = Date.now } = {}) {
  if (typeof sendNotification !== "function") return void 0;
  if (typeof progressToken !== "string" && typeof progressToken !== "number") return void 0;
  const gap = Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? minIntervalMs : PROGRESS_MIN_INTERVAL_MS;
  let sequence = 0;
  let lastAt = -Infinity;
  let lastPhase = null;
  return (event) => {
    try {
      const phase2 = typeof event?.phase === "string" ? event.phase : "\uC9C4\uD589";
      const at = now();
      if (phase2 === lastPhase && at - lastAt < gap) return;
      lastPhase = phase2;
      lastAt = at;
      sequence += 1;
      const step = Number.isInteger(event?.step) ? event.step : null;
      const sent = sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: sequence,
          message: step !== null && step > 0 ? `${phase2} (\uC2A4\uD15D ${step})` : phase2
        }
      });
      if (sent && typeof sent.catch === "function") sent.catch(() => {
      });
    } catch {
    }
  };
}
var HANDLERS = {
  orch_models: runOrchModels,
  orch_run: runOrchRun,
  orch_config: runOrchConfig,
  orch_stats: runOrchStats,
  orch_reward: runOrchReward
};
async function callTool(name, args, context = {}) {
  try {
    const spec = TOOL_SPECS.find((t) => t.name === name);
    if (!spec) {
      return failure({
        status: "invalid",
        error: `\uC54C \uC218 \uC5C6\uB294 \uB3C4\uAD6C: ${safeErrorText2(name)}`,
        recovery: `\uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uB3C4\uAD6C: ${TOOL_SPECS.map((t) => t.name).join(", ")}`
      });
    }
    const validated = validateArgs(args === void 0 ? {} : args, spec.args);
    if (!validated.ok) {
      return failure({ status: "invalid", error: validated.error, recovery: validated.recovery });
    }
    const handler = HANDLERS[spec.name];
    if (typeof handler !== "function") {
      return failure({
        status: "failed",
        error: `\uC11C\uBC84 \uB0B4\uBD80 \uBC30\uC120 \uC624\uB958: \uB3C4\uAD6C '${spec.name}' \uC758 \uC2A4\uD399\uC740 \uC788\uB294\uB370 \uD578\uB4E4\uB7EC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.`,
        recovery: "\uD638\uCD9C\uC790\uAC00 \uACE0\uCE60 \uC218 \uC788\uB294 \uBB38\uC81C\uAC00 \uC544\uB2D9\uB2C8\uB2E4. \uC11C\uBC84 \uB85C\uADF8\uC640 \uD568\uAED8 \uC774 \uBB38\uC7A5\uC744 \uADF8\uB300\uB85C \uC2E0\uACE0\uD558\uC138\uC694."
      });
    }
    return await handler(validated.value, context);
  } catch (error2) {
    return failure({
      status: "failed",
      error: safeErrorText2(error2),
      recovery: "\uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC11C\uBC84 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uC138\uC694."
    });
  }
}

// src/server.mjs
var REQUIRED_NODE_VERSION = { major: 20, minor: 10, patch: 0 };
var PINNED_PROTOCOL_VERSION = "2024-11-05";
function parseNodeVersion(raw) {
  const match = typeof raw === "string" ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
function isLowerVersion(a, b) {
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  return a.patch < b.patch;
}
function checkNodeVersion(env = process.env, actualVersionString = process.version) {
  const actual = parseNodeVersion(actualVersionString);
  let effective = actual;
  const fakeRaw = env.BOM_ORCH_FAKE_NODE_VERSION;
  if (typeof fakeRaw === "string" && fakeRaw !== "") {
    const fake = parseNodeVersion(fakeRaw);
    if (fake && actual && isLowerVersion(fake, actual)) effective = fake;
  }
  return Boolean(effective) && !isLowerVersion(effective, REQUIRED_NODE_VERSION);
}
if (!checkNodeVersion()) {
  console.error(
    `bom-orch \uB294 Node.js >=20.10 \uC774 \uD544\uC694\uD569\uB2C8\uB2E4. \uD604\uC7AC \uBC84\uC804: ${process.version}. Node \uB97C 20.10 \uC774\uC0C1\uC73C\uB85C \uC62C\uB9AC\uACE0 \uB2E4\uC2DC \uC2E4\uD589\uD558\uC138\uC694.`
  );
  process.exit(1);
}
process.on("unhandledRejection", (reason) => {
  console.error("\uCC98\uB9AC\uB418\uC9C0 \uC54A\uC740 \uD504\uB77C\uBBF8\uC2A4 \uAC70\uBD80:", reason);
});
process.on("uncaughtException", (error2) => {
  console.error("\uCC98\uB9AC\uB418\uC9C0 \uC54A\uC740 \uC608\uC678:", error2);
});
function describeThrown(error2) {
  if (error2 instanceof Error && typeof error2.message === "string" && error2.message !== "") return error2.message;
  try {
    const text = String(error2);
    return text !== "" ? text : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  } catch {
    return "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958";
  }
}
var packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
var packageJson = JSON.parse(await readFile10(packageJsonPath, "utf8"));
var stateRoot = resolveStateRoot();
var startupSweep = sweepOrphans({ stateRoot });
var startupPatchNoticeConsumed = false;
async function takeStartupPatchNotice() {
  const swept = await startupSweep;
  if (startupPatchNoticeConsumed || swept.patches.removed <= 0) return null;
  startupPatchNoticeConsumed = true;
  return `\uBD80\uD305 \uC2A4\uC715\uC774 \uC0C1\uD0DC \uB8E8\uD2B8\uC758 patches \uC5D0\uC11C 30\uC77C\uC774 \uC9C0\uB09C \uD328\uCE58 ${swept.patches.removed}\uAC1C\uB97C \uC9C0\uC6E0\uC2B5\uB2C8\uB2E4 \u2014 \uADF8 \uD30C\uC77C\uC5D0\uB294 \uB378\uB9AC\uAC8C\uC774\uD2B8\uAC00 \uB9CC\uB4E0 \uC18C\uC2A4\uAC00 \uD3C9\uBB38\uC73C\uB85C \uB4E4\uC5B4 \uC788\uC5B4 \uBCF4\uC874 \uC815\uCC45\uC73C\uB85C \uD68C\uC218\uD569\uB2C8\uB2E4.`;
}
var nestedRunId = typeof process.env.BOM_ORCH_RUN_ID === "string" && process.env.BOM_ORCH_RUN_ID !== "" ? process.env.BOM_ORCH_RUN_ID : null;
if (nestedRunId !== null) {
  console.error(
    `\uC911\uCCA9 \uC2E4\uD589 \uAC10\uC9C0: BOM_ORCH_RUN_ID=${nestedRunId} \uAC00 \uC774\uBBF8 \uC124\uC815\uB3FC \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uD504\uB85C\uC138\uC2A4\uB294 \uC6B0\uB9AC\uAC00 \uB9CC\uB4E0 \uB378\uB9AC\uAC8C\uC774\uD2B8 \uC790\uC2DD \uC548\uC5D0\uC11C \uB3CC\uACE0 \uC788\uB294 \uAC83\uC73C\uB85C \uBCF4\uACE0, \uB3C4\uAD6C \uD638\uCD9C\uC744 \uBAA8\uB450 \uAC70\uBD80\uD569\uB2C8\uB2E4.`
  );
}
var server = new Server({ name: "bom-orch", version: packageJson.version }, { capabilities: { tools: {} } });
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  const result = await server._oninitialize(request);
  return { ...result, protocolVersion: PINNED_PROTOCOL_VERSION };
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (nestedRunId !== null) {
    return serializeToolResult(
      failure({
        status: "blocked",
        error: `\uC911\uCCA9 \uC2E4\uD589\uC774 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4 (nested run, BOM_ORCH_RUN_ID=${nestedRunId}).`,
        recovery: "\uC774\uBBF8 \uC624\uCF00\uC2A4\uD2B8\uB808\uC774\uC158 \uC548\uC5D0\uC11C \uB3CC\uACE0 \uC788\uC2B5\uB2C8\uB2E4(\uC911\uCCA9/nested). \uBC14\uAE65 \uD504\uB85C\uC138\uC2A4\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694."
      })
    );
  }
  try {
    const onProgress = makeProgressReporter({
      sendNotification: extra?.sendNotification,
      progressToken: request.params?._meta?.progressToken
    });
    const startupNotice = await takeStartupPatchNotice();
    const envelope = await callTool(request.params.name, request.params.arguments, { stateRoot, onProgress });
    if (startupNotice !== null) {
      envelope.notice = typeof envelope.notice === "string" && envelope.notice !== "" ? `${startupNotice} ${envelope.notice}` : startupNotice;
    }
    return serializeToolResult(envelope);
  } catch (error2) {
    return serializeToolResult(
      failure({
        status: "failed",
        error: describeThrown(error2),
        recovery: "\uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC11C\uBC84 \uB85C\uADF8\uB97C \uD655\uC778\uD558\uC138\uC694."
      })
    );
  }
});
await server.connect(new StdioServerTransport());
