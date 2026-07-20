/** 飞书官方授权 URL 二维码，并尽力用系统打开。 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
export function defaultSetupQrPath(home=os.homedir()):string{return path.join(home,".pi","lark-hub","setup-qr.png")}
export type WriteQrResult={ok:true;path:string;payload:string}|{ok:false;error:string;path:string;payload:string};
export type WriteQrOptions={outPath?:string;toFile?:(filePath:string,text:string,opts?:{width?:number;margin?:number})=>Promise<void>};
export async function writeSetupQrPng(url:string,options:WriteQrOptions={}):Promise<WriteQrResult>{const outPath=options.outPath??defaultSetupQrPath();const toFile=options.toFile??((filePath,text,opts)=>QRCode.toFile(filePath,text,{type:"png",width:opts?.width??320,margin:opts?.margin??2}));try{mkdirSync(path.dirname(outPath),{recursive:true});await toFile(outPath,url,{width:320,margin:2});return{ok:true,path:outPath,payload:url}}catch(e){return{ok:false,error:e instanceof Error?e.message:String(e),path:outPath,payload:url}}}
export function openPathBestEffort(filePath:string,options:{platform?:NodeJS.Platform;spawnFn?:typeof spawn}={}):void{const platform=options.platform??process.platform;const run=options.spawnFn??spawn;try{if(platform==="win32")run("cmd",["/c","start","",filePath],{detached:true,stdio:"ignore",windowsHide:true}).unref();else if(platform==="darwin")run("open",[filePath],{detached:true,stdio:"ignore"}).unref();else run("xdg-open",[filePath],{detached:true,stdio:"ignore"}).unref()}catch{}}
