'use strict';

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as toml from 'toml';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    // console.log('"extern-crate-helper" is now active!');

    let externCrateHelper = new ExternCrateHelper();
    context.subscriptions.push(externCrateHelper);
}

export function deactivate() {
}

class ExternCrateHelperDiagnostic extends vscode.Diagnostic {
    public crate: string;

    constructor(crate: string, range: vscode.Range) {
        super(range, `Crate ${crate} is not found in Cargo.toml`, vscode.DiagnosticSeverity.Error);
        this.crate = crate;
    }
}

class ExternCrateHelperCommand implements vscode.Command {
    title: string;
    arguments?: any[];
    command: string = 'extern-crate-helper.addCrate';

    constructor(crate: string, dev: boolean) {
        let dev_str = dev ? "dev-" : "";
        this.title = `Add crate "${crate}" as a ${dev_str}dependency`;
        this.arguments = [crate, dev];
    }
}

class ExternCrateHelper {
    private _disposable: vscode.Disposable;
    private _manifestmtime: Date;
    private _manifest: any;
    private _manifestpath: string;
    private _diags: vscode.DiagnosticCollection;

    constructor() {
        let disposables: vscode.Disposable[] = [];

        disposables.push(vscode.commands.registerTextEditorCommand('extern-crate-helper.addCrate',
            (editor: vscode.TextEditor, edit: vscode.TextEditorEdit, crate: string, dev: boolean) => {
                console.log(`addCrate ${crate} ${dev}`);

                let args = ['add', crate];
                if (dev) {
                    args.push('--dev');
                }

                cp.execFile('cargo', args, { cwd: vscode.workspace.rootPath }, (err, stdout, stderr) => {
                    if (err && (err as any).code === 'ENOENT') {
                        vscode.window.showErrorMessage('cargo is not installed.');
                    } else if (stderr.length !== 0) {
                        if (stderr.startsWith('error: no such subcommand')) {
                            vscode.window.showErrorMessage('cargo-edit is not installed');
                        } else {
                            vscode.window.showErrorMessage(stderr);
                        }
                    } else {
                        this.checkDocument(editor.document);
                    }
                });
            }));

        this._diags = vscode.languages.createDiagnosticCollection("extern-crate-helper");
        disposables.push(this._diags);

        disposables.push(vscode.languages.registerCodeActionsProvider('rust', this));

        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (this.isCheckTarget(doc)) {
                this.checkDocument(doc);
            }
        }, disposables);

        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (this.isCheckTarget(doc)) {
                this.checkDocument(doc);
            } else {
                if (doc.languageId === 'toml' && path.basename(doc.fileName) === '/Cargo.toml') {
                    this.checkAll();
                }
            }
        }, disposables);

        this._disposable = vscode.Disposable.from(...disposables);

        this.checkAll();
    }

    dispose() {
        this._disposable.dispose();
    }

    provideCodeActions(doc: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        n: vscode.CancellationToken): Thenable<vscode.Command[]> {
        let diags = context.diagnostics.filter((d) => d instanceof ExternCrateHelperDiagnostic);
        if (diags.length === 0) {
            return Promise.reject("no diagnostics");
        }

        let diag = diags[0] as ExternCrateHelperDiagnostic;
        console.log('code action ' + diag.crate);
        return Promise.resolve([new ExternCrateHelperCommand(diag.crate, false),
        new ExternCrateHelperCommand(diag.crate, true)]);
    }

    private isCheckTarget(doc: vscode.TextDocument) {
        return doc.languageId === 'rust' && doc.fileName.startsWith(vscode.workspace.rootPath);
    }

    private checkAll() {
        for (let d of vscode.workspace.textDocuments) {
            if (this.isCheckTarget(d)) {
                this.checkDocument(d);
            }
        }
    }

    private checkDocument(doc: vscode.TextDocument) {
        this._diags.delete(doc.uri);

        let source = doc.getText();

        let masked = maskComments(source);
        let re = /extern\s+crate\s+(\w+)(?:\s+as\s+\w+)?;/g;
        let match: RegExpMatchArray;
        let crates: [number, string][] = [];
        while ((match = re.exec(masked)) !== null) {
            crates.push([match.index, match[1]]);
        }

        let manifestPath = path.join(vscode.workspace.rootPath, 'Cargo.toml');
        let mtime = fs.lstatSync(manifestPath).mtime;
        if (this._manifest === undefined || this._manifestpath !== manifestPath || this._manifestmtime < mtime) {
            this._manifestpath = manifestPath;
            this._manifestmtime = mtime;
            this._manifest = toml.parse(fs.readFileSync(manifestPath, 'utf8'));
        }

        let manifest = this._manifest;

        let lib_name = (manifest.lib && manifest.lib.name) || manifest.package && manifest.package.name;

        // self reference
        if (crates.some(([, crate]) => crate === lib_name.replace(/-/g, '_'))) {
            return;
        }

        let deps: string[] = [];
        if (manifest["dependencies"] !== null) {
            for (let k in manifest["dependencies"]) {
                deps.push(k.replace(/-/g, '_'));
            }
        }
        if (manifest["dev-dependencies"] !== null) {
            for (let k in manifest["dev-dependencies"]) {
                deps.push(k.replace(/-/g, '_'));
            }
        }

        deps = deps.filter((x, index) => deps.indexOf(x) === index);

        let diags: vscode.Diagnostic[] = [];

        for (let [index, crate] of crates) {
            if (deps.findIndex((x) => x === crate) === -1) {
                console.log(crate);
                diags.push(new ExternCrateHelperDiagnostic(
                    crate,
                    new vscode.Range(doc.positionAt(index),
                        doc.positionAt(source.indexOf(';', index) + 1))
                ));
            }
        }

        this._diags.set(doc.uri, diags);
    }
}

function maskComments(src: string): string {
    return src.replace(/\/\*.*?\*\//g, (s) => ' '.repeat(s.length))
        .replace(/\/\/.*?\n/g, (s) => ' '.repeat(s.length));
}