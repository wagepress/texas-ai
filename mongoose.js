const mongoose = require('mongoose')
const { DB_URL } = require('./config')

mongoose.connect(DB_URL).then(() => console.log('connected to Database')).catch(Err => console.log('Err', Err))
