// Arnés temporal: probar el endpoint nuevo contra la base real, sin desplegar.
process.env.PGSSL = 'true';
const express = require('express');
