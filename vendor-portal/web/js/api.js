"use strict";

export class ApiError extends Error {
  constructor(message, status){
    super(message);
    this.status = status;
  }
}

async function request(method, path, body){
  var res = await fetch('/api' + path, {
    method: method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if(res.status === 401){
    throw new ApiError('Not authenticated', 401);
  }

  if(!res.ok){
    var payload = await res.json().catch(function(){ return {}; });
    throw new ApiError(payload.error || ('Request failed (' + res.status + ')'), res.status);
  }

  if(res.status === 204) return null;
  return res.json();
}

export var api = {
  get: function(path){ return request('GET', path); },
  post: function(path, body){ return request('POST', path, body); },
  put: function(path, body){ return request('PUT', path, body); },
  delete: function(path){ return request('DELETE', path); }
};
