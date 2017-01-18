var MONGODB_RECONNECT_INTERVAL = 1000;
var MEMCACHED_LIFETIME = 10;
var MEMCACHED_TIMEOUT = 100;
var ERR_MEMCACHED_DEAD = "Error: memcached dead";
var ERR_MYSQL_DUPLICATE_ENTRY = "ER_DUP_ENTRY";

var NO_ROOT = process.argv[2] === "--no-root";

// DEPENDENCIES
var express = require("express");
var bodyParser = require("body-parser");
//var mysql = require("mysql");
var parallel = require("async").parallel;
var Memcached = require('memcached');
var _ = require("lodash");
var http = require('http');
var fs = require('fs');
var stream = require("stream");
var cors = require("cors");
var async = require("async");
var config = require("./config.json");
var mongodb = require('mongodb');



/*//getCarUrl es una funcio asincrona que executa un callback amb la (url d'un cotxe)
var getCarUrl = function (car, cb) {
  //async.parallel executa les funcions dintre de [] a la vegada
  //quan acaben d'executarse, s'executa la ultima
  async.parallel([
    function (callback) {
      //Si el objecte cotxe que rebem no conte el parametre maker.name
      if (!car.maker.name) {
        //demanem el nom del maker (que es la id) a la BDD
        queryDB("SELECT * FROM car_maker WHERE id = " + car.maker, function (err, res) {
          //i el guardem
          car.maker = res[0];
          //callback (null) avisa a parallel que la funcio ja s'ha executat
          callback(null);
        });
      }
      else
        callback(null);
    },
    function (callback) {
      if (!car.color.name) {
        queryDB("SELECT * FROM car_color WHERE id = " + car.color, function (err, res) {
          car.color = res[0];
          callback(null);
        });
      }
      else
        callback(null);
    }
  ], function (err, res) {
    //Una vegada executades les funcions precedents[]
    //el callback de getCarUrl conte la url de la imatge (url)
    cb(err, "img/cars/" + car.maker.name + "_" + car.name + "_" + car.color.name + ".jpg");
  });
};
*/

/*
// Rep els filtres i genera les consultes SQL
function getConsulta (filter) {
  // Valors per defecte de offset i limit si aquests no es proporcionen
  if (filter.offset === undefined) filter.offset = 1;
  if (filter.limit === undefined) filter.limit = 6;

  // Variable on es guarda la consulta general
  var consulta = "SELECT * FROM car_model";

  // makersSeleccionats conte les id's dels makers seleccionats
  var makersSeleccionats = filter.maker
    .filter(function (el){ //.filter (funcio d'arrays) executa una funcio per cada element de l'array
                           // si aquesta funcio, retorna true, l'element es queda a l'array
                           // en cas contrari, l'elimina d l'array
      return el.seleccionat; //retorna el valor .seleccionat de cada element
    })
    .map(function (el){ //.map executa la funcio per a cada element
      // i el substitueix per el valor que retorna la funcio (id del maker)
      return el.id;
    });

  var colorsSeleccionats = filter.color
    .filter(function (el){
        return el.seleccionat;
    })
    .map(function (el){
      return el.id;
    });

  // Si hi ha algun filtre seleccionat, s'afegeix "WHERE" a la consulta
  if (makersSeleccionats.length !== 0 || colorsSeleccionats.length !== 0)
    consulta += " WHERE ";

  // Si hi ha fabricants seeleccionats
  if (makersSeleccionats.length !== 0) {
    // _.join (lodash) converteix un array a una cadena interposant el segon parametre
    // entre els seus elements
    makersSeleccionats = _.join(makersSeleccionats, ", ");
    console.log("Makers: " + makersSeleccionats);

    consulta += "maker in (" + makersSeleccionats + ")";
  }

  // Si els dos filtres tenen alguna cosa seleccionada, afegim "AND" a la consulta
  if (makersSeleccionats.length !== 0 && colorsSeleccionats.length !== 0)
    consulta += " AND ";

  if (colorsSeleccionats.length !== 0) {
    colorsSeleccionats = _.join(colorsSeleccionats, ", ");
    console.log("Colors: " + colorsSeleccionats);

    consulta += "color in (" + colorsSeleccionats + ")";
  }

  // Afegir a la consulta limit i offset per a que els cotxes es mostrin de 3 en 3
  consulta += " LIMIT " + filter.limit + " OFFSET " + filter.offset;
  consulta += ";";

  // Retornem la variable que conte la consulta
  return consulta;
}
*/

var app = express();

// Variable que indica l'estat del servidor mysql (false = caigut)
var mongoDBStatus = false;

// Declarem la variable de conexio fora per que hi tingui acces
// la resta del programa
var con;
var mongoCon;

//Conexio a la BDD
//We need to work with "MongoClient" interface in order to connect to a mongodb server.
var MongoClient = mongodb.MongoClient;

// Connection URL. This is where your mongodb server is running.
var url = 'mongodb://localhost:27017/chatdb';

function connectaBaseDades() {
  console.log("Intentant connectar al servidor MongoDB");

  // La funcio connectaBaseDades inicia la conexio, per tant,
  // per definicio, la conexio esta offline fins que no tingui exit
  mongoDBStatus = false;

  // Use connect method to connect to the Server
  MongoClient.connect(url, function (err, db) {
    if (err) {
      console.error('Error conectant a MongoDB: ' + err.code);

      // La conexio ha fallat, per tant el server esta offline
      mongoDBStatus = false;

      console.log("Tornant a intentar en " + MONGODB_RECONNECT_INTERVAL + " milis");
      // Tornem a intentar la conexio cada MONGODB_RECONNECT_INTERVAL segons
      setTimeout(connectaBaseDades, MONGODB_RECONNECT_INTERVAL);
      connectaBaseDades();

    } else {
      // We are connected. :)
      console.log('Connection established to', url);
      mongoCon = db;
      mongoDBStatus = true;

    }
  });

/*
  // Quan la conexio a mysql pateix un error, el mostrem per consola i intentem reconectar
  con.on('error', function (err) {
    console.error("Error de conexio a la BDD");
    console.error(err);

    connectaBaseDades();
  });
  */
}

// Iniciem la conexio a mysql
connectaBaseDades();

// Iniciem la conexio a memcached
var mem = new Memcached(config.memcached.ip);
console.log("Conectat a memcached");

// Variable que assigna un numero a cada query per fer un seguiment
var queryDBIdx = 0;

// queryDB es una funcio d'alt nivell que demana les dades de una consulta
// poden venir tant de memcached com de SQL
// query es la consulta SQL
// skipMemcahed es un boolean que indica si ens volem saltar el memcached
// cb es la funcio (callback) que s'executa quan es te una resposta
function queryDB (query, skipMemcahed, cb) {
  // Si el cb no esta a la tercera posicio, vol dir que esta a la segona
  // per tant reordenem els parametres per a que el callback estigui a la tercera posicio
  if (!cb) {
    cb = skipMemcahed;
    skipMemcahed = false;
  }

  // key es la query sense espais, per que memcached es queixa
  var key = query.replace(/\s/g, '');

  var thisIdx = queryDBIdx++;

  console.log("queryDB[" + thisIdx + "]: " + query);

  var memcachedGetCb = function (err, data) {
    var memcachedStatus = true;

    // si err es ERR_MEMCACHED_DEAD, vol dir que memcached
    // ha trigat massa en contestar i considerem que esta mort
    if (err === ERR_MEMCACHED_DEAD)
      memcachedStatus = false;

    // qualsevol altre error
    else if (err)
      console.error("queryDB[" + thisIdx + "]: memcached: ", err);

    // si la resposta esta a cache, la retornem
    if (data !== undefined) {
      console.log("queryDB[" + thisIdx + "]: memcached te la resposta. executant cb");
      // establim la propietat source de les dades que es retornen
      // (origen de les dades (memcached o MySQL))
      data.source = "memcached";
      return cb(undefined, data);
    }

    if (!skipMemcahed)
      console.log("queryDB[" + thisIdx + "]: memcached no te la resposta");

    console.log("queryDB[" + thisIdx + "]: Demanant la resposta a SQL");
    // en cas de que no tingui la resposta, demanem la resposta a SQL
    con.query(query, function (err, rows) {
      if (err)
        return cb(err);

      // Si memcached esta viu, i no el saltem, guardem les dades de sql a memcached
      if (memcachedStatus && !skipMemcahed) {
        console.log("queryDB[" + thisIdx + "]: guardant resposta a memcached");
        // guardem la resposta de la consulta SQL a memcached
        mem.set(key, rows, MEMCACHED_LIFETIME, function (err) {
          if (err)
            console.error("queryDB[" + thisIdx + "]: guardar a memcached ha fallat");
        });
      }

      console.log("queryDB[" + thisIdx + "]: executant cb");
      // establim la propietat source de les dades que es retornen
      // (origen de les dades (memcached o MySQL))
      rows.source = "MySQL";
      // retornem la resposta
      cb(undefined, rows);
    });
  };

  // Si saltem memcached executem el callback sense parametres directament
  if (skipMemcahed) {
    return memcachedGetCb();
  }
  else {
    var aux = true;

    console.log("queryDB[" + thisIdx + "]: demanant resposta a memcached");
    // Demanem a memcached el resultat de la consulta (data)
    //mem.get es una funcio que pregunta al servidor memcached per la key ( query )
    //Si memcached li respon en menys temps del especificat en el timeout
    //executa la funcio memcachedGetCb que continua el proces de la query
    //marca aux a false perque no es torni a executar la funcio memcachedGetCb
    mem.get(key, function(err, data) {
      if (aux) {
        aux = false;
        //Execucio de memcachedGetCb
        //amb parametres que el servidor memcached ha proporcionat com a respostes
        memcachedGetCb(err, data);
      }
    });

    //Si ha passat el temps especificat en el timeot i mem.get no ha rebut resposta
    // del servidor memcached, executa la funcio memcachedGetCb sense parametres
    // per continuar el proces
    setTimeout(function () {
      if (aux) {
        aux = false;
        console.error("queryDB[" + thisIdx + "]: memcached ha trigat massa en respondre!");

        // cridem el callback amb un missatge d'error
        memcachedGetCb(ERR_MEMCACHED_DEAD);
      }
    }, MEMCACHED_TIMEOUT);
  }
}

//Parseja el json a objectes de javascript per poder treballar amb ells
app.use(bodyParser.json());

// Si node s'executa amb `--no-root`, no es defineix la ruta `/` ni les rutes estatiques
// es apache qui s'encarrega de donar els recursos estatics (HTML, JS, CSS...)
if (NO_ROOT) {
  console.log("Executant com a webservice");

  // Afegeix capcaleres CORS per que l'apache pugui fer peticions
  app.use(cors());

// Per defecte declarem la ruta arrel `/` i les rutes estatiques
// node s'encarrega de distribuir HTML, JS, CSS...
} else {
  console.log("Executant com a standalone");

  // Prepara el directori "app" per a recursos estatics
  app.use(express.static("app"));

  // Ruta root
  app.get("/", function(req, res){
    res.sendFile(__dirname + "/index.html");
  });
}

// Ruta per fer login
app.post("/login", function (req, res) {
  console.log("Peticio /login");

  var username = req.body.username,
      password = req.body.password;

  // Consulta que selecciona el registre de la taula users que correspon amb l'usuari i la password
  queryDB("SELECT id, username FROM users WHERE username LIKE '" + username + "' AND password LIKE '" + password + "'", function (err, rows) {
    if (err)
      console.log(err);

    // Si la longitud de resultats es mes gran que 0 vol dir que l'usuari existeix
    if (rows.length > 0)
      res.send({success: true, user: rows[0]});

    else
      res.send({err: "User does not exist! Try signing up."});
  })
});

// Ruta per crear usuaris nous
app.post("/signup", function (req, res) {
  console.log("Peticio /signup");

  var id = req.body.id,
      name = req.body.name,
      surname1 = req.body.surname1,
      surname2 = req.body.surname2,
      gender = req.body.gender,
      age = req.body.age;


//EXEMPLE DE UTILITZACIO DE MONGODB AMB LA VARIABLE GLOBAL mongoCon = db
    // Get the documents collection
    var collection = mongoCon.collection('users');

    //Create some users
    var user1 = {name: 'modulus admin', age: 42, roles: ['admin', 'moderator', 'user']};
    var user2 = {name: 'modulus user', age: 22, roles: ['user']};
    var user3 = {name: 'modulus super admin', age: 92, roles: ['super-admin', 'admin', 'moderator', 'user']};

    // Insert some users
    collection.insert([user1, user2, user3], function (err, result) {
      if (err) {
        console.log(err);
      } else {
        console.log('Inserted %d documents into the "users" collection. The documents inserted with "_id" are:', result.length, result);
      }

  // Query que insereix el nou usuari a la taula users
  queryDB("INSERT INTO users (id, name, surname1, surname2, gender, age) VALUES (" + id + ", '" + name + "','" + surname1 "','" + surname2 "','" + gender "'," + age ")", true, function (err, rows) {
    // Si l'usuari esta duplicat li fem saber al client
    if (err && err.code === ERR_MYSQL_DUPLICATE_ENTRY)
      res.send({errdup: err});

    // Qualsevol altre error tambe l'enviem al client
    else if (err)
      res.send({err: err});

    else
      res.send({success: true});
  })
});

//setPreferences envia JSON al servidor amb les preferencies del usuari.
//Un usuari pot tenir molts tipus de musica preferida (rap, rock, heavy, etc). ->

app.post("/setPreferences", function (req, res) {
  console.log("Peticio /setPreferences");

  var id = req.body.id,
      preferences = [
          req.body.music,
          req.body.movies,
          req.body.trips,
          req.body.sport,
          req.body.games,
          req.body.profession,
          req.body.food,
          req.body.literature,
          req.body.hobbies
      ];
});

// Ruta getCars retorna les dades de la crida de la BDD en JSON
app.post("/getCars", function(req, res){
  console.log("Peticio /getCars");

  // Comprovem que tenim conexio a mysql i en cas negatiu,
  // s'envia un missatge d'error a l'usuari
  if (!mysqlStatus) {
    res.send({err: {code: "Servidor MySQL offline!"}});
  } else { // Si hi ha conexio, continuem amb la query
    var consulta = getConsulta(req.body);

    // Hem de fer dos consultes per cada peticio a /getCars
    // infoCars es l'objecte que contindra el resultat de les dues consultes
    var infoCars = {};

    // Executa la consulta SQL
    queryDB(consulta, function queryCb(err, rows) {
      if (err) {
        // En cas d'error, imprimirlo per consola
        console.error(err);
        // L'error s'enviara al client dins d'un objecte sota la key "err"
        res.send({err: err});
      } else {
        //console.log(rows);
        infoCars.rows = rows;

        //async.map rep les rows de la queryDB (objecte car)
        //i retorna una array (urls) amb les url del les imatges
        //executant la funcio getCarUrl per cada cotxe (rows)
        async.map(rows, getCarUrl, function (err, urls) {
          //Recorrem les dos arrays (array de cars (rows) i array de urls (urls))
          for (var i = 0; i < rows.length; i++) {
            //i inserim la url de cada cotxe a infoCars.rows[i].url
            infoCars.rows[i].url = urls[i];
          }

          // source es una variable que conte l'origien de les dades
          // assignem l'origen de les dades a l'objecte que retornem al client
          infoCars.source = rows.source;
          res.send(infoCars);
        });
      }
    });
  }
});

//app.get defineix la ruta del servidor
//(/getInfo) retorna les dades del servidor per dibuixar els filtres
app.get("/getInfo", function(req, res){
  console.log("Peticio informacio");

  if (!mysqlStatus) {
    res.send({err: {code: "Servidor MySQL offline!"}});
  } else {
    //objecte que conté els valors dels filtres
    var info = {
      source: {}
    };
    //variable auxiliar per saber quan les dues querys han finalitzat
    var estatQuery = 0;

    //Funcio que s'executa sempre que acaba 1 query,
    //pero només enviará les dades a angular quan hagin finalitzat les 2 querys
    function estatCheck () {
      if (estatQuery === 2) {
        res.send(info);
      }
    }

    //Una vegada la query ha finalitzat, s'executa una funció que guarda el resultat de la query
    //en info.maker
    queryDB('SELECT * FROM car_maker', function queryCIM(err, rows){
      if (err) {
        // En cas d'error, imprimirlo per consola
        console.error(err);
        // L'error s'enviara al client dins d'un objecte sota la key "err"
        res.send({err: err});
      } else {
        //console.log(rows);
        info.maker = rows;
        info.source.maker = rows.source;
        estatQuery++;
        estatCheck();
      }
    });

    queryDB('SELECT * FROM car_color', function queryCIC(err, rows){
      if (err) {
        // En cas d'error, imprimirlo per consola
        console.error(err);
        // L'error s'enviara al client dins d'un objecte sota la key "err"
        res.send({err: err});
      } else {
        //console.log(rows);
        info.color = rows;
        info.source.color = rows.source;
        estatQuery++;
        estatCheck();
      }
    });
  }
});

app.post("/addMaker", function (req, res) {
  // console.log(req.data);
  req.body.name = req.body.name.toLowerCase();
  queryDB("INSERT INTO car_maker(name) VALUES ('" + req.body.name + "')", true, function (err) {
    //Si retorna error amb valor ERR_MYSQL_DUPLICATE_ENTRY, vol dir que l'usuari intenta introduir
    //un fabricant ja existent
    if (err && err.code === ERR_MYSQL_DUPLICATE_ENTRY) {
      console.log(err);
      //envia l'error
      res.send({
        errdup: err
      });
    }
    //Si es error general, l'envia
    else if(err) {
      console.log(err)
      res.send({
        err: err
      })
    }
    //Sino hi ha error, retorna el registre corresponent al fabricant creat
    else {
      queryDB("SELECT * FROM car_maker WHERE name like '" + req.body.name + "'", function(err,rows){
        res.send(rows[0]);
      });
    }
  });
});

//Peticio post per afegir color nou
app.post("/addColor", function (req, res) {
  //console.log(req.data);
  req.body.name = req.body.name.toLowerCase();
  //Query per inserir el nou color a la bdd
  queryDB("INSERT INTO car_color(name) VALUES ('" + req.body.name + "')", true, function (err) {

    if (err && err.code === ERR_MYSQL_DUPLICATE_ENTRY) {
      console.log(err);
      res.send({
        errdup: err
      });
    }
    else if(err) {
      console.log(err)
      res.send({
        err: err
      })
    }

    else {
      queryDB("SELECT * FROM car_color WHERE name like '" + req.body.name + "'", function(err,rows){
        res.send(rows[0]);
      });
    }
  });
});

//peticio al servidor node al accedir a /addCar
app.post("/addCar", function (req, res) {
  req.body.name = req.body.name.toLowerCase();
  //query que insereix totes les dades introduides per l'usuari dins de la taula car_model
  //on tenim totes les dades dels cotxes
  queryDB("INSERT INTO car_model (maker,name,color) VALUES (" + req.body.maker.id + ", '" + req.body.name + "', " + req.body.color.id + ")", true, function (err) {
    if (err && err.code === ERR_MYSQL_DUPLICATE_ENTRY) {
      console.log(err);
      res.send({
        errdup: err
      });
    }
    //Si retorna error amb valor diferent a ERR_MYSQL_DUPLICATE_ENTRY, vol dir que ha hagut un error general
    else if(err) {
      console.log(err)
      res.send({
        err: err
      })
    }

    else {
      if (!req.body.img) {
        res.send({err: "Error uploading image! Try again."});

      } else {
        getCarUrl(req.body, function (err, url) {
          //fs.createWriteStream crea un stream per escriure un fitxer
          //se li pasa la ruta de l'arxiu (imatge)
          //url es la url de la imatge que retorna el callback de la funcio getCarUrl
          var file = fs.createWriteStream("app/" + url);
          //creem un buffer (array de bytes) a partir de les dades de la imatge
          //codificades en base64, que rebem del client
          var imgBytes = new Buffer(req.body.img, "base64");
          //emmagatzema la resposta al arxiu (imatge)
          var bufferStream = new stream.PassThrough();
          bufferStream.end(imgBytes);
          bufferStream.pipe(file);

          //Si no hi ha cap error, s'envia al client success: true
          res.send({success: true});
        });
      }
    }
  });
});

// Iniciem el servidor
app.listen(8080, function(){
  console.log("Servidor iniciat a localhost:8080");
});
