import {signIn} from './chatgpt-plan-client.mjs';
try{const status=await signIn({onReady:({launchUrl})=>console.log(JSON.stringify({phase:'awaiting_user_sign_in',launchUrl}))});console.log(JSON.stringify(status));if(!status.planScopeGranted)process.exitCode=2;}
catch{console.error('ChatGPT plan sign-in could not start; no tokens were printed.');process.exitCode=2;}
